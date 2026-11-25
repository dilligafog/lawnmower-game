import { type Obstacle, type Yard } from './yard';
import { catmullRom, smoothStroke } from './route';
import {
  type Vec,
  add,
  closestOnPolyline,
  cross,
  dist,
  dot,
  lerp,
  norm,
  scale,
  signedArea,
  sub,
} from './vec';

export interface OffsetLoop {
  /** Closed loop (first point repeated at the end). */
  loop: Vec[];
  /** Mitered corner points: where the offset lines of two adjacent edges meet. */
  corners: Vec[];
}

/**
 * Trace a polygon at a fixed offset, outside it (obstacles) or inside it
 * (the property line). Corners that bulge toward the mower are rounded, since
 * the deck pivots around them; corners that pinch in (the inside of a V-shaped
 * bed, the corners of a lot) are mitered, leaving the little spots that only a
 * trimmer can reach.
 */
export function offsetPolygon(points: Vec[], offset: number, inward = false): OffsetLoop {
  // Normalize winding so that (d.y, -d.x) points to the side we are offsetting toward.
  const poly = signedArea(points) >= 0 !== inward ? points : points.slice().reverse();
  const n = poly.length;
  const normal = (a: Vec, b: Vec): Vec => {
    const d = norm(sub(b, a));
    return { x: d.y, y: -d.x };
  };
  const loop: Vec[] = [];
  const corners: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const v = poly[i];
    const next = poly[(i + 1) % n];
    const n1 = normal(prev, v);
    const n2 = normal(v, next);
    const bis = norm(add(n1, n2));
    const c = dot(bis, n1);
    const miter = add(v, scale(bis, offset / Math.max(0.25, c)));
    // Only real corners (a turn of 20°+) get a snap point; gentle bends in a hose don't.
    const turn = Math.abs(cross(norm(sub(v, prev)), norm(sub(next, v))));
    if (c > 0.35 && turn > Math.sin((20 * Math.PI) / 180)) corners.push(miter);
    if (cross(sub(v, prev), sub(next, v)) > 0) {
      const a1 = Math.atan2(n1.y, n1.x);
      let sweep = Math.atan2(n2.y, n2.x) - a1;
      while (sweep < 0) sweep += Math.PI * 2;
      const steps = Math.max(1, Math.ceil(sweep / (Math.PI / 12)));
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (sweep * s) / steps;
        loop.push({ x: v.x + Math.cos(a) * offset, y: v.y + Math.sin(a) * offset });
      }
    } else {
      loop.push(miter);
    }
  }
  loop.push(loop[0]);
  return { loop, corners };
}

/** Closed loop tracing an obstacle at a fixed offset outside it. */
export function obstacleContour(o: Obstacle, offset: number): Vec[] {
  if (o.shape === 'polygon') return offsetPolygon(o.points, offset).loop;
  const r = o.r + offset;
  const n = Math.max(24, Math.ceil((Math.PI * 2 * r) / 8));
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r });
  }
  return pts;
}

/** A snap-able edge line: an obstacle contour or the inside of the property line. */
export interface Guide {
  loop: Vec[];
  /** Arc length at each loop point. */
  cum: number[];
  total: number;
}

function makeGuide(loop: Vec[]): Guide {
  const cum = [0];
  for (let i = 1; i < loop.length; i++) cum.push(cum[i - 1] + dist(loop[i - 1], loop[i]));
  return { loop, cum, total: cum[cum.length - 1] };
}

export interface Projection {
  guide: number;
  /** Arc length along the guide. */
  s: number;
  point: Vec;
  d: number;
}

export type SnapKind = 'corner' | 'point' | 'edge' | 'axis' | 'grid' | 'none';

export interface SnapResult {
  point: Vec;
  kind: SnapKind;
  /** For axis snaps: the point we lined up with. */
  alignedWith?: Vec;
}

export interface SnapOptions {
  grid: number;
  /** Mower deck width: edges snap to half a deck away so the deck just kisses the obstacle. */
  deckWidth: number;
  /** Snap radii in world px. */
  cornerRadius: number;
  pointRadius: number;
  edgeRadius: number;
  axisRadius: number;
}

export const DEFAULT_SNAP: Omit<SnapOptions, 'deckWidth'> = {
  grid: 8,
  cornerRadius: 24,
  pointRadius: 14,
  edgeRadius: 20,
  axisRadius: 10,
};

export class Snapper {
  readonly guides: Guide[] = [];
  readonly corners: Vec[] = [];

  constructor(
    yard: Yard,
    private opts: SnapOptions,
  ) {
    const offset = opts.deckWidth / 2 + 1;
    for (const o of yard.def.obstacles) {
      if (o.shape === 'circle') {
        this.guides.push(makeGuide(obstacleContour(o, offset)));
      } else {
        const { loop, corners } = offsetPolygon(o.points, offset);
        this.guides.push(makeGuide(loop));
        this.corners.push(...corners);
      }
    }
    const lot = offsetPolygon(yard.def.property, offset, true);
    this.guides.push(makeGuide(lot.loop));
    this.corners.push(...lot.corners);
  }

  /**
   * Snap priority: corners, then route anchors, then edges, then lining up
   * horizontally/vertically with `from`, then the grid.
   */
  snap(p: Vec, useGrid: boolean, anchors: Vec[] = [], from?: Vec): SnapResult {
    const o = this.opts;
    const nearest = (pts: Vec[], r: number) => {
      let best: Vec | null = null;
      let bestD = r;
      for (const c of pts) {
        const d = dist(c, p);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      return best;
    };
    const corner = nearest(this.corners, o.cornerRadius);
    if (corner) return { point: corner, kind: 'corner' };
    const anchor = nearest(anchors, o.pointRadius);
    if (anchor) return { point: anchor, kind: 'point' };
    const edge = this.project(p, o.edgeRadius);
    if (edge) return { point: edge.point, kind: 'edge' };

    let x = p.x;
    let y = p.y;
    let aligned = false;
    if (from && Math.abs(p.x - from.x) < o.axisRadius) {
      x = from.x;
      aligned = true;
    }
    if (from && Math.abs(p.y - from.y) < o.axisRadius) {
      y = from.y;
      aligned = true;
    }
    if (useGrid) {
      if (x === p.x) x = Math.round(p.x / o.grid) * o.grid;
      if (y === p.y) y = Math.round(p.y / o.grid) * o.grid;
    }
    if (aligned) return { point: { x, y }, kind: 'axis', alignedWith: from };
    return { point: { x, y }, kind: useGrid ? 'grid' : 'none' };
  }

  /** Nearest point on any guide within `radius`. */
  project(p: Vec, radius: number, only?: number): Projection | null {
    let best: Projection | null = null;
    for (let gi = 0; gi < this.guides.length; gi++) {
      if (only !== undefined && gi !== only) continue;
      const g = this.guides[gi];
      const hit = closestOnPolyline(p, g.loop);
      if (hit.d < radius && (!best || hit.d < best.d)) {
        best = {
          guide: gi,
          s: g.cum[hit.index] + dist(g.loop[hit.index], hit.point),
          point: hit.point,
          d: hit.d,
        };
      }
    }
    return best;
  }

  /** Points along a guide from arc length s0 to s1 (excluding s0), the short way round. */
  between(gi: number, s0: number, s1: number): Vec[] {
    const g = this.guides[gi];
    let delta = s1 - s0;
    if (delta > g.total / 2) delta -= g.total;
    if (delta < -g.total / 2) delta += g.total;
    const out: Vec[] = [];
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / 4));
    for (let i = 1; i <= steps; i++) out.push(this.pointAt(gi, s0 + (delta * i) / steps));
    return out;
  }

  pointAt(gi: number, s: number): Vec {
    const g = this.guides[gi];
    s = ((s % g.total) + g.total) % g.total;
    let i = 1;
    while (i < g.cum.length - 1 && g.cum[i] < s) i++;
    const span = g.cum[i] - g.cum[i - 1];
    return lerp(g.loop[i - 1], g.loop[i], span > 0 ? (s - g.cum[i - 1]) / span : 0);
  }

  /**
   * Freehand with a sticky edge: parts of the stroke that come within
   * `radius` of an edge lock onto it exactly (and stay locked until the stroke
   * pulls ~1.6x the radius away); everything else is smoothed freehand.
   */
  stickyPath(raw: Vec[], radius = this.opts.edgeRadius): Vec[] {
    const out: Vec[] = [];
    let free: Vec[] = [];
    let prev: Projection | null = null;
    const flushFree = () => {
      if (free.length === 0) return;
      const pts = free.length > 2 ? catmullRom(smoothStroke(free)) : free;
      out.push(...pts);
      free = [];
    };
    for (const p of raw) {
      const held: Projection | null = prev ? this.project(p, radius * 1.6, prev.guide) : null;
      const pr: Projection | null = held ?? this.project(p, radius);
      if (pr) {
        flushFree();
        if (prev && prev.guide === pr.guide) out.push(...this.between(pr.guide, prev.s, pr.s));
        else out.push(pr.point);
      } else {
        free.push(p);
      }
      prev = pr;
    }
    flushFree();
    // Drop near-duplicate points.
    return out.filter((p, i) => i === 0 || dist(p, out[i - 1]) > 0.5);
  }
}

/** Snap the direction from `from` to `p` to the nearest multiple of `stepDeg`. */
export function snapAngle(from: Vec, p: Vec, stepDeg = 15): Vec {
  const d = sub(p, from);
  const l = Math.hypot(d.x, d.y);
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(d.y, d.x) / step) * step;
  return { x: from.x + Math.cos(a) * l, y: from.y + Math.sin(a) * l };
}
