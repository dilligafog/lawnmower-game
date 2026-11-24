import { describe, expect, it } from 'vitest';
import { YARDS } from '../data/yards';
import { STARTER_MOWER } from './mower';
import {
  type Route,
  curveControlThrough,
  quadBezier,
  resample,
  sampleRoute,
  smoothStroke,
  stripeFill,
} from './route';
import { simulateJob } from './score';
import { buildTimeline } from './simulation';
import { obstacleContour, loopFrom } from './snap';
import { dist, type Vec } from './vec';
import { type YardDef, buildYard, obstacleDistance, CELL_GRASS, CELL_SOLID } from './yard';

const mower = STARTER_MOWER;
const deck = mower.deckWidth;

function emptyYard(width = 256, height = 160, extra: Partial<YardDef> = {}): YardDef {
  return {
    id: 't',
    name: 'test',
    width,
    height,
    cellSize: 4,
    start: { x: deck / 2, y: deck / 2 },
    pavement: [],
    obstacles: [],
    ...extra,
  };
}

/** Serpentine stripes covering the whole yard edge to edge. */
function fullStripes(def: YardDef): Route {
  const h = deck / 2;
  const count = Math.ceil((def.height - deck) / (deck * 0.9)) + 1;
  const spacing = (def.height - deck) / (count - 1);
  const pts = stripeFill({ x: h, y: h }, { x: def.width - h, y: h }, 1, count, spacing);
  return { start: pts[0], segments: [{ kind: 'polyline', points: pts }] };
}

describe('route geometry', () => {
  it('resamples at uniform spacing', () => {
    const pts = resample(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      2,
    );
    expect(pts.length).toBe(51);
    for (let i = 1; i < pts.length; i++) expect(dist(pts[i - 1], pts[i])).toBeCloseTo(2, 5);
  });

  it('builds curves that pass through the dragged point', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const through = { x: 50, y: 40 };
    const c = curveControlThrough(a, b, through);
    const mid = quadBezier(a, c, b, 0.5);
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(40);
  });

  it('smooths a jittery straight stroke down to its endpoints', () => {
    const raw: Vec[] = [];
    for (let x = 0; x <= 200; x += 1) raw.push({ x, y: x % 2 === 0 ? 0 : 1 });
    expect(smoothStroke(raw)).toHaveLength(2);
  });

  it('stripe fill alternates direction and offsets each pass', () => {
    const pts = stripeFill({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 3, 30);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    const last = pts[pts.length - 1];
    expect(last.x).toBeCloseTo(100);
    expect(last.y).toBeCloseTo(60);
  });
});

describe('obstacle contours', () => {
  it('traces circles at a constant offset', () => {
    const tree = { shape: 'circle' as const, kind: 'tree' as const, x: 50, y: 50, r: 20 };
    for (const p of obstacleContour(tree, 16)) expect(obstacleDistance(p, tree)).toBeCloseTo(16, 5);
  });

  it('traces a V-shaped bed (with a concave notch) at a constant offset', () => {
    const vBed = YARDS.home.obstacles.find(
      (o) => o.shape === 'polygon' && o.kind === 'bed' && o.points.length === 6,
    )!;
    for (const p of obstacleContour(vBed, 17)) {
      expect(obstacleDistance(p, vBed)).toBeGreaterThan(16.5);
      expect(obstacleDistance(p, vBed)).toBeLessThan(17.5);
    }
  });

  it('loopFrom closes back on its starting point', () => {
    const tree = { shape: 'circle' as const, kind: 'tree' as const, x: 50, y: 50, r: 20 };
    const loop = loopFrom(obstacleContour(tree, 10), { x: 0, y: 50 });
    expect(loop[0]).toEqual(loop[loop.length - 1]);
    expect(loop[0].x).toBeCloseTo(20, 0);
  });
});

describe('timeline', () => {
  it('straight driving costs only distance / speed', () => {
    const t = buildTimeline(
      resample(
        [
          { x: 0, y: 0 },
          { x: 450, y: 0 },
        ],
        2,
      ),
      mower,
    );
    expect(t.totalTime).toBeCloseTo(10, 3);
    expect(t.turnTime).toBe(0);
  });

  it('a sharp V corner costs more than a rounded turn of the same angle', () => {
    const sharp: Route = {
      start: { x: 0, y: 0 },
      segments: [
        { kind: 'line', to: { x: 100, y: 0 } },
        { kind: 'line', to: { x: 0, y: 30 } },
      ],
    };
    const rounded: Route = {
      start: { x: 0, y: 0 },
      segments: [
        { kind: 'polyline', points: stripeFill({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, 2, 30) },
      ],
    };
    const tSharp = buildTimeline(sampleRoute(sharp), mower);
    const tRound = buildTimeline(sampleRoute(rounded), mower);
    expect(tSharp.turnTime).toBeGreaterThan(tRound.turnTime * 1.5);
  });
});

describe('yard + mowing', () => {
  it('rasterizes obstacles into the grid', () => {
    const yard = buildYard(YARDS.home);
    const at = (x: number, y: number) =>
      yard.cells[Math.floor(y / 4) * yard.cols + Math.floor(x / 4)];
    expect(at(400, 100)).toBe(CELL_SOLID);
    expect(at(50, 600)).toBe(CELL_GRASS);
    expect(yard.grassCount).toBeGreaterThan(0);
  });

  it('a full stripe fill covers nearly everything with no damage', () => {
    const def = emptyYard();
    const r = simulateJob(buildYard(def), mower, fullStripes(def));
    expect(r.coverage).toBeGreaterThan(0.95);
    expect(r.damage).toHaveLength(0);
    expect(r.stars).toBeGreaterThanOrEqual(4);
  });

  it('a half-finished job scores worse than a full one', () => {
    const def = emptyYard();
    const yard = buildYard(def);
    const full = fullStripes(def);
    const pts = (full.segments[0] as { points: Vec[] }).points;
    const half: Route = {
      start: full.start,
      segments: [{ kind: 'polyline', points: pts.slice(0, Math.floor(pts.length / 2)) }],
    };
    const a = simulateJob(yard, mower, full);
    const b = simulateJob(yard, mower, half);
    expect(a.coverage).toBeGreaterThan(b.coverage);
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('records damage when driving through a tree', () => {
    const def = emptyYard(256, 160, {
      obstacles: [{ shape: 'circle', kind: 'tree', x: 128, y: 80, r: 15 }],
    });
    const route: Route = {
      start: { x: 20, y: 80 },
      segments: [{ kind: 'line', to: { x: 236, y: 80 } }],
    };
    const r = simulateJob(buildYard(def), mower, route);
    expect(r.damage.map((d) => d.kind)).toEqual(['tree']);
  });

  it('counts overlap when re-mowing the same strip', () => {
    const def = emptyYard();
    const yard = buildYard(def);
    const once: Route = {
      start: { x: 20, y: 80 },
      segments: [{ kind: 'line', to: { x: 236, y: 80 } }],
    };
    const twice: Route = {
      ...once,
      segments: [...once.segments, { kind: 'line', to: { x: 20, y: 80 } }],
    };
    expect(simulateJob(yard, mower, once).overlap).toBeLessThan(0.05);
    expect(simulateJob(yard, mower, twice).overlap).toBeGreaterThan(0.7);
  });
});
