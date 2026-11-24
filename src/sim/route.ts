import { type Vec, add, closestOnSegment, dist, lerp, norm, perp, scale, sub, cross } from './vec';

/**
 * A route is a start point plus a chain of segments; each segment begins where
 * the previous one ended. This mirrors city-builder road tools: the player
 * picks a segment type and the game fits the geometry.
 */
export type Segment =
  | { kind: 'line'; to: Vec }
  /** Quadratic bezier from the previous end, through `control`'s pull, to `to`. */
  | { kind: 'curve'; control: Vec; to: Vec }
  /** Smoothed freehand: a Catmull-Rom spline through `points` (points[0] = previous end). */
  | { kind: 'spline'; points: Vec[] }
  /** Exact generated geometry (stripe fills, obstacle contours). points[0] = previous end. */
  | { kind: 'polyline'; points: Vec[] };

export interface Route {
  start: Vec;
  segments: Segment[];
}

export function segmentEnd(seg: Segment): Vec {
  switch (seg.kind) {
    case 'line':
    case 'curve':
      return seg.to;
    case 'spline':
    case 'polyline':
      return seg.points[seg.points.length - 1];
  }
}

export function routeEnd(route: Route): Vec {
  const last = route.segments[route.segments.length - 1];
  return last ? segmentEnd(last) : route.start;
}

export function quadBezier(a: Vec, c: Vec, b: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

/** Control point such that the quadratic curve from a to b passes through `through` at t=0.5. */
export function curveControlThrough(a: Vec, b: Vec, through: Vec): Vec {
  return { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
}

/** Centripetal-ish Catmull-Rom through all points (uniform parameterization). */
export function catmullRom(points: Vec[], samplesPerSpan = 12): Vec[] {
  if (points.length < 3) return points.slice();
  const out: Vec[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 1; s <= samplesPerSpan; s++) {
      const t = s / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

/** Ramer-Douglas-Peucker simplification. */
export function simplify(points: Vec[], epsilon: number): Vec[] {
  if (points.length < 3) return points.slice();
  const a = points[0];
  const b = points[points.length - 1];
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = dist(points[i], closestOnSegment(points[i], a, b).point);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= epsilon) return [a, b];
  const left = simplify(points.slice(0, idx + 1), epsilon);
  const right = simplify(points.slice(idx), epsilon);
  return left.slice(0, -1).concat(right);
}

/** Clean up a raw pointer stroke into spline control points. */
export function smoothStroke(raw: Vec[], minSpacing = 6, epsilon = 2.5): Vec[] {
  const decimated: Vec[] = [];
  for (const p of raw) {
    const last = decimated[decimated.length - 1];
    if (!last || dist(last, p) >= minSpacing) decimated.push(p);
  }
  const lastRaw = raw[raw.length - 1];
  if (lastRaw && decimated[decimated.length - 1] !== lastRaw) decimated.push(lastRaw);
  return simplify(decimated, epsilon);
}

/** Resample a polyline at uniform arc-length spacing. */
export function resample(pts: Vec[], spacing: number): Vec[] {
  if (pts.length === 0) return [];
  const out: Vec[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    if (segLen === 0) continue;
    let d = spacing - carry;
    while (d <= segLen) {
      out.push(lerp(a, b, d / segLen));
      d += spacing;
    }
    carry = segLen - (d - spacing);
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > 1e-6) out.push(last);
  return out;
}

/** Dense (non-uniform) points for a segment, excluding its start point. */
export function segmentPoints(from: Vec, seg: Segment): Vec[] {
  switch (seg.kind) {
    case 'line':
      return [seg.to];
    case 'curve': {
      const n = Math.max(8, Math.ceil((dist(from, seg.control) + dist(seg.control, seg.to)) / 4));
      const out: Vec[] = [];
      for (let i = 1; i <= n; i++) out.push(quadBezier(from, seg.control, seg.to, i / n));
      return out;
    }
    case 'spline':
      return catmullRom(seg.points).slice(1);
    case 'polyline':
      return seg.points.slice(1);
  }
}

export function routePolyline(route: Route): Vec[] {
  const pts: Vec[] = [route.start];
  let cur = route.start;
  for (const seg of route.segments) {
    pts.push(...segmentPoints(cur, seg));
    cur = segmentEnd(seg);
  }
  return pts;
}

export function sampleRoute(route: Route, spacing = 2): Vec[] {
  return resample(routePolyline(route), spacing);
}

/**
 * Serpentine stripe fill: first pass from `a` to `b`, then `count - 1` more
 * passes offset by `spacing` toward `side` (+1 / -1), joined by U-turns.
 *
 * The U-turns stay inside the a..b span: the turn's apex reaches the line
 * end, so pass ends get pulled back by the turn radius. That leaves scalloped
 * ends between passes, which a perimeter lap cleans up (the classic pro pattern).
 */
export function stripeFill(a: Vec, b: Vec, side: 1 | -1, count: number, spacing: number): Vec[] {
  const dir = norm(sub(b, a));
  const passLen = dist(a, b);
  const off = scale(perp(dir), side * spacing);
  const offDir = norm(off);
  const r = Math.min(spacing / 2, passLen / 3);
  const steps = 10;
  const pts: Vec[] = [];
  for (let i = 0; i < count; i++) {
    const forward = i % 2 === 0;
    const base = scale(off, i);
    const from = add(forward ? a : b, base);
    const to = add(forward ? b : a, base);
    const travel = forward ? dir : scale(dir, -1);
    const start = i > 0 ? sub(from, scale(travel, -r)) : from;
    const end = i < count - 1 ? sub(to, scale(travel, r)) : to;
    if (i === 0) pts.push(start);
    pts.push(end);
    if (i === count - 1) break;
    // Semicircle from `end` to the next pass's start, bulging forward by r.
    const center = add(end, scale(offDir, spacing / 2));
    for (let s = 1; s < steps; s++) {
      const t = (s / steps) * Math.PI;
      pts.push(
        add(
          center,
          add(scale(travel, Math.sin(t) * r), scale(offDir, -Math.cos(t) * (spacing / 2))),
        ),
      );
    }
  }
  return pts;
}

/** Which side of the line a->b the point p falls on (+1 / -1), matching stripeFill's `side`. */
export function sideOf(a: Vec, b: Vec, p: Vec): 1 | -1 {
  return cross(sub(b, a), sub(p, a)) >= 0 ? 1 : -1;
}
