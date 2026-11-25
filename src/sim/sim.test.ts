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
import { DEFAULT_SNAP, Snapper, obstacleContour, offsetPolygon } from './snap';
import { dist, type Vec } from './vec';
import {
  type YardDef,
  buildYard,
  obstacleDistance,
  polygonDistance,
  isValidStart,
  CELL_GRASS,
  CELL_NEIGHBOR,
  CELL_SOLID,
} from './yard';

const mower = STARTER_MOWER;
const deck = mower.deckWidth;

function emptyYard(width = 256, height = 160, extra: Partial<YardDef> = {}): YardDef {
  return {
    id: 't',
    name: 'test',
    order: 0,
    customer: 'test',
    challenge: 'test',
    tip: '',
    zones: [],
    width,
    height,
    cellSize: 4,
    start: { x: deck / 2, y: deck / 2 },
    property: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
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
      (o) => o.shape === 'polygon' && o.kind === 'flowers' && o.points.length === 6,
    )!;
    for (const p of obstacleContour(vBed, 17)) {
      expect(obstacleDistance(p, vBed)).toBeGreaterThan(16.5);
      expect(obstacleDistance(p, vBed)).toBeLessThan(17.5);
    }
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
    expect(at(500, 170)).toBe(CELL_SOLID);
    expect(at(130, 640)).toBe(CELL_GRASS);
    expect(at(40, 400)).toBe(CELL_NEIGHBOR);
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

describe('snapping', () => {
  const yard = buildYard(YARDS.home);
  const snapper = new Snapper(yard, { ...DEFAULT_SNAP, deckWidth: deck });
  const off = deck / 2 + 1;

  it('offsets the property line inward with sharp (mitered) corners', () => {
    const { loop, corners } = offsetPolygon(YARDS.home.property, off, true);
    for (const p of loop) expect(polygonDistance(p, YARDS.home.property)).toBeCloseTo(-off, 5);
    expect(corners).toContainEqual({ x: 80 + off, y: 40 + off });
  });

  it('snaps to the corner behind the house from a sloppy click', () => {
    // House top-left corner is (380, 100); the outside corner guide sits half a deck out.
    const s = snapper.snap({ x: 380 - off + 15, y: 100 - off - 12 }, true);
    expect(s.kind).toBe('corner');
    expect(s.point.x).toBeCloseTo(380 - off);
    expect(s.point.y).toBeCloseTo(100 - off);
  });

  it('lines up horizontally/vertically with the previous point', () => {
    const s = snapper.snap({ x: 500, y: 456 }, false, [], { x: 350, y: 450 });
    expect(s.kind).toBe('axis');
    expect(s.point).toEqual({ x: 500, y: 450 });
  });

  it('edge strokes lock exactly onto the edge they pass near', () => {
    // A wobbly drag along the left side of the house, ~10px out from the guide line.
    const raw: Vec[] = [];
    for (let y = 120; y <= 230; y += 3) raw.push({ x: 380 - off - 10 + (y % 2), y });
    const pts = snapper.stickyPath(raw);
    for (const p of pts) expect(p.x).toBeCloseTo(380 - off, 5);
  });

  it('only accepts pavement as a start point', () => {
    expect(isValidStart(yard, { x: 680, y: 700 })).toBe(true); // driveway
    expect(isValidStart(yard, { x: 300, y: 770 })).toBe(true); // street
    expect(isValidStart(yard, { x: 300, y: 500 })).toBe(false); // lawn
  });

  it("flags driving onto the neighbor's lawn", () => {
    const route: Route = {
      start: { x: 680, y: 700 },
      segments: [
        { kind: 'line', to: { x: 200, y: 600 } },
        { kind: 'line', to: { x: 20, y: 600 } },
      ],
    };
    const r = simulateJob(yard, mower, route);
    expect(r.damage.map((d) => d.kind)).toContain('neighbor');
  });
});
