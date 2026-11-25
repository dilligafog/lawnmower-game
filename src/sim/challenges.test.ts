import { describe, expect, it } from 'vitest';
import { type RawObstacle, type RawYard, type RawZone, loadYard } from '../data/yards/loader';
import { STARTER_MOWER } from './mower';
import { type Route, stripeFill } from './route';
import { DAMAGE_PENALTY, simulateJob } from './score';
import { type Vec } from './vec';
import { buildYard } from './yard';

const mower = STARTER_MOWER;
const deck = mower.deckWidth;
const h = deck / 2;

/** A plain 400x400 lot with whatever obstacles/zones a test needs. */
function lot(obstacles: RawObstacle[] = [], zones: RawZone[] = []) {
  const raw: RawYard = {
    id: 'test',
    name: 'test',
    order: 0,
    customer: '',
    challenge: '',
    tip: '',
    width: 400,
    height: 400,
    start: { x: h, y: h },
    property: { shape: 'rect', x: 0, y: 0, w: 400, h: 400 },
    pavement: [],
    obstacles,
    zones,
  };
  return buildYard(loadYard(raw));
}

const poly = (points: Vec[]): Route => ({
  start: points[0],
  segments: [{ kind: 'polyline', points }],
});

/** Serpentine fill of the whole 400x400 lot, horizontal or vertical passes. */
function fill(dir: 'across' | 'updown'): Route {
  const spacing = deck * 0.9;
  const count = Math.ceil((400 - deck) / spacing) + 1;
  const pts =
    dir === 'across'
      ? stripeFill({ x: h, y: h }, { x: 400 - h, y: h }, 1, count, (400 - deck) / (count - 1))
      : stripeFill({ x: h, y: h }, { x: h, y: 400 - h }, -1, count, (400 - deck) / (count - 1));
  return poly(pts);
}

describe('slopes', () => {
  const hill = lot(
    [],
    [
      {
        shape: 'rect',
        x: 0,
        y: 0,
        w: 400,
        h: 400,
        kind: 'slope',
        downhill: { x: 0, y: 1 },
        grade: 0.8,
      },
    ],
  );
  const flat = lot();

  it('slow the mower down', () => {
    expect(simulateJob(hill, mower, fill('across')).time).toBeGreaterThan(
      simulateJob(flat, mower, fill('across')).time,
    );
  });

  it('reward mowing across the hill over up and down', () => {
    const across = simulateJob(hill, mower, fill('across'));
    const updown = simulateJob(hill, mower, fill('updown'));
    expect(across.coverage).toBeCloseTo(updown.coverage, 1);
    expect(across.time).toBeLessThan(updown.time * 0.9);
    expect(across.efficiency).toBeGreaterThan(updown.efficiency);
  });
});

describe('thick grass', () => {
  const thick = lot([], [{ shape: 'rect', x: 0, y: 0, w: 400, h: 400, kind: 'thick' }]);

  it('needs two passes to count as cut', () => {
    const once = simulateJob(thick, mower, fill('across'));
    const p = (fill('across').segments[0] as { points: Vec[] }).points;
    const twice = simulateJob(thick, mower, poly([...p, ...p.slice().reverse()]));
    expect(once.coverage).toBeLessThan(0.3);
    expect(twice.coverage).toBeGreaterThan(0.9);
    // The second pass isn't "wasted overlap": thick grass needed it.
    expect(twice.overlap).toBeLessThan(0.3);
  });

  it('is slower to mow than normal grass', () => {
    expect(simulateJob(thick, mower, fill('across')).time).toBeGreaterThan(
      simulateJob(lot(), mower, fill('across')).time * 1.3,
    );
  });
});

describe('fences and gates', () => {
  /** A fence across the middle of the lot with a gap of `gap` px centered at x=200. */
  const fenced = (gap: number) =>
    lot([
      {
        shape: 'line',
        kind: 'fence',
        points: [
          { x: 0, y: 200 },
          { x: 200 - gap / 2 - 2, y: 200 },
        ],
      },
      {
        shape: 'line',
        kind: 'fence',
        points: [
          { x: 200 + gap / 2 + 2, y: 200 },
          { x: 400, y: 200 },
        ],
      },
    ]);
  const through: Route = {
    start: { x: 200, y: 300 },
    segments: [{ kind: 'line', to: { x: 200, y: 100 } }],
  };

  it('leave a trim strip that does not count against coverage', () => {
    const y = fenced(48);
    const open = lot();
    expect(y.edgeCount).toBeGreaterThan(0);
    expect(y.grassCount).toBeLessThan(open.grassCount);
  });

  it('let the mower through a wide gate but not a narrow one', () => {
    expect(simulateJob(fenced(48), mower, through).damage).toHaveLength(0);
    expect(simulateJob(fenced(24), mower, through).damage.map((d) => d.kind)).toContain('fence');
  });

  it('can be hugged along the snap line without damage', () => {
    const along: Route = {
      start: { x: 40, y: 200 + 2 + h + 1 },
      segments: [{ kind: 'line', to: { x: 140, y: 200 + 2 + h + 1 } }],
    };
    expect(simulateJob(fenced(48), mower, along).damage).toHaveLength(0);
  });
});

describe('toys, hoses and beds', () => {
  const across: Route = {
    start: { x: 20, y: 200 },
    segments: [{ kind: 'line', to: { x: 380, y: 200 } }],
  };

  it('running over a toy or hose is an incident', () => {
    const toy = lot([{ shape: 'circle', kind: 'toy', x: 200, y: 214, r: 8 }]);
    expect(simulateJob(toy, mower, across).damage.map((d) => d.kind)).toEqual(['toy']);
    const hose = lot([
      {
        shape: 'line',
        kind: 'hose',
        points: [
          { x: 200, y: 100 },
          { x: 210, y: 300 },
        ],
      },
    ]);
    expect(simulateJob(hose, mower, across).damage.map((d) => d.kind)).toEqual(['hose']);
  });

  it('flowers cost more goodwill than mulch', () => {
    expect(DAMAGE_PENALTY.flowers).toBeGreaterThan(DAMAGE_PENALTY.bed);
    const bed = (kind: 'bed' | 'flowers') =>
      simulateJob(
        lot([{ shape: 'rect', kind, x: 180, y: 180, w: 40, h: 40 }]),
        mower,
        fill('across'),
      );
    expect(bed('flowers').satisfaction).toBeLessThan(bed('bed').satisfaction);
  });
});
