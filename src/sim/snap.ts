import { type Obstacle, type Yard } from './yard';
import { type Vec, add, closestOnPolyline, cross, dot, norm, scale, signedArea, sub } from './vec';

/**
 * Closed loop that traces an obstacle at a fixed offset, used for edge snapping
 * and the Contour tool. Convex corners are rounded (a mower pivots around them);
 * concave corners (like the inside of a V-shaped bed) use a mitered point.
 * The returned loop repeats its first point at the end.
 */
export function obstacleContour(o: Obstacle, offset: number): Vec[] {
  if (o.shape === 'circle') {
    const r = o.r + offset;
    const n = Math.max(24, Math.ceil((Math.PI * 2 * r) / 8));
    const pts: Vec[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push({ x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r });
    }
    return pts;
  }

  const poly = signedArea(o.points) >= 0 ? o.points : o.points.slice().reverse();
  const n = poly.length;
  // For positive-area winding, the outward normal of edge direction d is (d.y, -d.x).
  const outward = (a: Vec, b: Vec): Vec => {
    const d = norm(sub(b, a));
    return { x: d.y, y: -d.x };
  };
  const pts: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const v = poly[i];
    const next = poly[(i + 1) % n];
    const n1 = outward(prev, v);
    const n2 = outward(v, next);
    const convex = cross(sub(v, prev), sub(next, v)) > 0;
    if (convex) {
      const a1 = Math.atan2(n1.y, n1.x);
      let sweep = Math.atan2(n2.y, n2.x) - a1;
      while (sweep < 0) sweep += Math.PI * 2;
      const steps = Math.max(1, Math.ceil(sweep / (Math.PI / 12)));
      for (let s = 0; s <= steps; s++) {
        const a = a1 + (sweep * s) / steps;
        pts.push({ x: v.x + Math.cos(a) * offset, y: v.y + Math.sin(a) * offset });
      }
    } else {
      const bis = norm(add(n1, n2));
      const c = Math.max(0.25, dot(bis, n1));
      pts.push(add(v, scale(bis, offset / c)));
    }
  }
  pts.push(pts[0]);
  return pts;
}

export type SnapKind = 'edge' | 'grid' | 'point' | 'none';

export interface SnapResult {
  point: Vec;
  kind: SnapKind;
}

export interface SnapOptions {
  grid: number;
  /** Mower deck width: edges snap to half a deck away so the deck just kisses the obstacle. */
  deckWidth: number;
  radius: number;
}

export class Snapper {
  private contours: { obstacle: Obstacle; loop: Vec[] }[];

  constructor(
    private yard: Yard,
    private opts: SnapOptions,
  ) {
    this.contours = yard.def.obstacles.map((o) => ({
      obstacle: o,
      loop: obstacleContour(o, opts.deckWidth / 2 + 1),
    }));
  }

  contourFor(o: Obstacle): Vec[] {
    return this.contours.find((c) => c.obstacle === o)?.loop ?? [];
  }

  snap(p: Vec, useGrid: boolean, anchors: Vec[] = []): SnapResult {
    for (const a of anchors) {
      if (Math.hypot(a.x - p.x, a.y - p.y) < this.opts.radius) return { point: a, kind: 'point' };
    }
    let best: SnapResult | null = null;
    let bestD = this.opts.radius;
    for (const { loop } of this.contours) {
      const hit = closestOnPolyline(p, loop);
      if (hit.d < bestD) {
        bestD = hit.d;
        best = { point: hit.point, kind: 'edge' };
      }
    }
    if (best) return best;
    // Yard edges (fence line), offset by half a deck. Snapping to both axes gives a corner.
    const half = this.opts.deckWidth / 2 + 1;
    const { width, height } = this.yard.def;
    const r = this.opts.radius;
    const fx = [half, width - half].find((x) => Math.abs(p.x - x) < r);
    const fy = [half, height - half].find((y) => Math.abs(p.y - y) < r);
    if (fx !== undefined || fy !== undefined) {
      return { point: { x: fx ?? p.x, y: fy ?? p.y }, kind: 'edge' };
    }
    if (useGrid) {
      const g = this.opts.grid;
      return { point: { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }, kind: 'grid' };
    }
    return { point: p, kind: 'none' };
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

/** Rotate a closed contour so it starts at the point nearest `from`; returns an open-then-closed loop. */
export function loopFrom(loop: Vec[], from: Vec): Vec[] {
  const open = loop.slice(0, -1);
  const hit = closestOnPolyline(from, loop);
  const startIdx = (hit.index + 1) % open.length;
  const rotated = open.slice(startIdx).concat(open.slice(0, startIdx));
  return [hit.point, ...rotated, hit.point];
}
