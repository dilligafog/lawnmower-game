import { type MowerSpec } from './mower';
import { type Route, sampleRoute } from './route';
import { type Vec, dist, wrapAngle } from './vec';
import { CELL_GRASS, type HitKind, type Yard, hitTest } from './yard';

export const SAMPLE_SPACING = 2;

/** A route turned into timed samples for a specific mower. */
export interface Timeline {
  points: Vec[];
  headings: number[];
  /** Arc length at each sample. */
  dist: number[];
  /** Game time at which the mower reaches each sample. */
  times: number[];
  totalTime: number;
  totalDist: number;
  /** Portion of totalTime spent turning. */
  turnTime: number;
}

/**
 * Time model: driving costs distance / topSpeed. Every bit of heading change
 * costs turnTimePerRad, multiplied up to 3x when the turn is tighter than the
 * mower's minimum radius (sharp V corners mean stopping and pivoting). This is
 * what makes long straight stripes the naturally efficient pattern.
 */
export function buildTimeline(points: Vec[], mower: MowerSpec): Timeline {
  const n = points.length;
  const headings: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.min(i, n - 2)] ?? points[0];
    const b = points[Math.min(i + 1, n - 1)] ?? points[0];
    headings[i] = Math.atan2(b.y - a.y, b.x - a.x);
  }
  const d: number[] = [0];
  const times: number[] = [0];
  let turnTime = 0;
  for (let i = 1; i < n; i++) {
    const ds = dist(points[i - 1], points[i]);
    const dTheta = Math.abs(wrapAngle(headings[i] - headings[i - 1]));
    const curvature = ds > 0 ? dTheta / ds : 0;
    const sharpness = 1 + Math.min(2, Math.max(0, curvature * mower.minTurnRadius - 1));
    const turn = dTheta * mower.turnTimePerRad * sharpness;
    turnTime += turn;
    d.push(d[i - 1] + ds);
    times.push(times[i - 1] + ds / mower.topSpeed + turn);
  }
  return {
    points,
    headings,
    dist: d,
    times,
    totalTime: times[n - 1] ?? 0,
    totalDist: d[n - 1] ?? 0,
    turnTime,
  };
}

export interface DamageEvent {
  kind: HitKind;
  at: Vec;
  time: number;
}

/**
 * Mutable state of one mowing job: walks the timeline and stamps the deck
 * onto the yard's coverage grid. Pure logic, no rendering.
 */
export class MowSession {
  readonly timeline: Timeline;
  /** Number of distinct passes over each cell. */
  readonly passes: Uint16Array;
  /** Stripe shade of the last pass over each cell: 1 light, -1 dark, 0 uncut. */
  readonly shade: Int8Array;
  readonly damage: DamageEvent[] = [];
  /** Cell indices changed since the last drain (may contain duplicates). */
  dirty: number[] = [];
  time = 0;
  private next = 0;
  private lastTouch: Float32Array;
  private inHit: HitKind | null = null;
  private cutCount = 0;

  constructor(
    readonly yard: Yard,
    readonly mower: MowerSpec,
    route: Route,
  ) {
    this.timeline = buildTimeline(sampleRoute(route, SAMPLE_SPACING), mower);
    const size = yard.cols * yard.rows;
    this.passes = new Uint16Array(size);
    this.shade = new Int8Array(size);
    this.lastTouch = new Float32Array(size).fill(-1);
  }

  get done(): boolean {
    return this.next >= this.timeline.points.length;
  }

  get cutCells(): number {
    return this.cutCount;
  }

  get coverage(): number {
    return this.yard.grassCount === 0 ? 1 : this.cutCount / this.yard.grassCount;
  }

  /** Advance game time, stamping every sample reached. */
  advanceTo(t: number): void {
    this.time = Math.min(t, this.timeline.totalTime);
    const { times } = this.timeline;
    while (this.next < times.length && times[this.next] <= t) {
      this.stamp(this.next);
      this.next++;
    }
  }

  runToEnd(): void {
    this.advanceTo(Infinity);
  }

  /** Interpolated mower pose at the current time. */
  pose(): { pos: Vec; heading: number } {
    const { points, times, headings } = this.timeline;
    if (points.length === 0) return { pos: this.yard.def.start, heading: 0 };
    const i = Math.max(0, this.next - 1);
    if (i >= points.length - 1) return { pos: points[points.length - 1], heading: headings[i] };
    const span = times[i + 1] - times[i];
    const f = span > 0 ? Math.min(1, Math.max(0, (this.time - times[i]) / span)) : 0;
    const a = points[i];
    const b = points[i + 1];
    return { pos: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, heading: headings[i] };
  }

  private stamp(i: number): void {
    const { yard, mower } = this;
    const p = this.timeline.points[i];
    const s = this.timeline.dist[i];
    const heading = this.timeline.headings[i];
    const cs = yard.cellSize;
    const r = mower.deckWidth / 2;
    const r2 = r * r;
    // Stripe shade follows the dominant travel axis: up/right light, down/left dark.
    const hx = Math.cos(heading);
    const hy = Math.sin(heading);
    const shade = Math.abs(hx) >= Math.abs(hy) ? (hx >= 0 ? 1 : -1) : hy < 0 ? 1 : -1;
    const newPassGap = mower.deckWidth * 1.5;

    const c0 = Math.max(0, Math.floor((p.x - r) / cs));
    const c1 = Math.min(yard.cols - 1, Math.floor((p.x + r) / cs));
    const r0 = Math.max(0, Math.floor((p.y - r) / cs));
    const r1 = Math.min(yard.rows - 1, Math.floor((p.y + r) / cs));
    for (let row = r0; row <= r1; row++) {
      const cy = (row + 0.5) * cs - p.y;
      for (let col = c0; col <= c1; col++) {
        const cx = (col + 0.5) * cs - p.x;
        if (cx * cx + cy * cy > r2) continue;
        const idx = row * yard.cols + col;
        if (yard.cells[idx] !== CELL_GRASS) continue;
        const last = this.lastTouch[idx];
        if (last < 0 || s - last > newPassGap) {
          if (this.passes[idx] === 0) this.cutCount++;
          this.passes[idx]++;
        }
        this.lastTouch[idx] = s;
        if (this.shade[idx] !== shade) {
          this.shade[idx] = shade;
          this.dirty.push(idx);
        }
      }
    }

    // Damage: the mower body (inner part of the deck) entering an obstacle or the fence.
    const hit = hitTest(yard, p, mower.deckWidth * 0.3);
    if (hit && hit !== this.inHit) {
      this.damage.push({ kind: hit, at: p, time: this.timeline.times[i] });
    }
    this.inHit = hit;
  }
}
