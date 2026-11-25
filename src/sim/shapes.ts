import { type Vec, add, norm, perp, scale, sub, dot } from './vec';

export function rectPolygon(x: number, y: number, w: number, h: number): Vec[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function ellipsePolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  angleDeg = 0,
  segments = 28,
): Vec[] {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const pts: Vec[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const x = Math.cos(t) * rx;
    const y = Math.sin(t) * ry;
    pts.push({ x: cx + x * ca - y * sa, y: cy + x * sa + y * ca });
  }
  return pts;
}

/**
 * Outline of a polyline stroked to `width` (square caps, mitered joints).
 * Used for fences and hoses so everything downstream only deals in polygons.
 */
export function strokePolygon(points: Vec[], width: number): Vec[] {
  const h = width / 2;
  const n = points.length;
  const dirs: Vec[] = [];
  for (let i = 0; i < n - 1; i++) dirs.push(norm(sub(points[i + 1], points[i])));
  const left: Vec[] = [];
  const right: Vec[] = [];
  for (let i = 0; i < n; i++) {
    let offset: Vec;
    let p = points[i];
    if (i === 0) {
      offset = scale(perp(dirs[0]), h);
      p = sub(p, scale(dirs[0], h));
    } else if (i === n - 1) {
      offset = scale(perp(dirs[n - 2]), h);
      p = add(p, scale(dirs[n - 2], h));
    } else {
      const n1 = perp(dirs[i - 1]);
      const n2 = perp(dirs[i]);
      const m = norm(add(n1, n2));
      offset = scale(m, h / Math.max(0.3, dot(m, n1)));
    }
    left.push(add(p, offset));
    right.push(sub(p, offset));
  }
  return [...left, ...right.reverse()];
}
