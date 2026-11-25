import { ellipsePolygon, rectPolygon, strokePolygon } from '../../sim/shapes';
import type { Vec } from '../../sim/vec';
import type { Obstacle, ObstacleKind, Pavement, PavementKind, YardDef, Zone } from '../../sim/yard';

/**
 * Yard data file format. Shapes can be written however is most convenient;
 * the loader turns everything into circles and polygons.
 *
 *   { "shape": "rect", "x": 0, "y": 0, "w": 10, "h": 10 }
 *   { "shape": "polygon", "points": [{ "x": 0, "y": 0 }, ...] }   ("shape" optional when "points" is given)
 *   { "shape": "ellipse", "x": 0, "y": 0, "rx": 40, "ry": 20, "angle": 15 }
 *   { "shape": "circle", "x": 0, "y": 0, "r": 20 }                 (obstacles only)
 *   { "shape": "line", "points": [...], "width": 4 }               (obstacles only: fences, hoses)
 */
export type RawShape =
  | { shape: 'rect'; x: number; y: number; w: number; h: number }
  | { shape?: 'polygon'; points: Vec[] }
  | { shape: 'ellipse'; x: number; y: number; rx: number; ry: number; angle?: number }
  | { shape: 'circle'; x: number; y: number; r: number }
  | { shape: 'line'; points: Vec[]; width?: number };

export type RawObstacle = RawShape & { kind: ObstacleKind };
export type RawPavement = RawShape & { kind: PavementKind };
export type RawZone = RawShape &
  ({ kind: 'thick' } | { kind: 'slope'; downhill: Vec; grade: number });

export interface RawYard {
  id: string;
  name: string;
  order: number;
  customer: string;
  challenge: string;
  tip: string;
  width: number;
  height: number;
  cellSize?: number;
  start: Vec;
  property: RawShape;
  pavement: RawPavement[];
  obstacles: RawObstacle[];
  zones?: RawZone[];
}

const DEFAULT_LINE_WIDTH: Partial<Record<ObstacleKind, number>> = { fence: 4, hose: 4 };

function toPolygon(s: RawShape, what: string): Vec[] {
  switch (s.shape) {
    case 'rect':
      return rectPolygon(s.x, s.y, s.w, s.h);
    case 'ellipse':
      return ellipsePolygon(s.x, s.y, s.rx, s.ry, s.angle ?? 0);
    case 'circle':
      return ellipsePolygon(s.x, s.y, s.r, s.r);
    case 'line':
      return strokePolygon(s.points, s.width ?? 4);
    case 'polygon':
    case undefined:
      if (!Array.isArray(s.points) || s.points.length < 3) {
        throw new Error(`${what}: polygon needs at least 3 points`);
      }
      return s.points;
  }
}

function toObstacle(o: RawObstacle, what: string): Obstacle {
  if (o.shape === 'circle') return { shape: 'circle', kind: o.kind, x: o.x, y: o.y, r: o.r };
  if (o.shape === 'line') {
    const width = o.width ?? DEFAULT_LINE_WIDTH[o.kind] ?? 4;
    return {
      shape: 'polygon',
      kind: o.kind,
      points: strokePolygon(o.points, width),
      centerline: o.points,
    };
  }
  return { shape: 'polygon', kind: o.kind, points: toPolygon(o, what) };
}

function normalizeDownhill(v: Vec): Vec {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
}

export function loadYard(raw: RawYard): YardDef {
  const where = `yard "${raw.id}"`;
  for (const key of ['id', 'name', 'width', 'height', 'start', 'property'] as const) {
    if (raw[key] === undefined) throw new Error(`${where}: missing "${key}"`);
  }
  const pavement: Pavement[] = raw.pavement.map((p, i) => ({
    kind: p.kind,
    points: toPolygon(p, `${where} pavement #${i}`),
  }));
  const zones: Zone[] = (raw.zones ?? []).map((z, i) => {
    const points = toPolygon(z, `${where} zone #${i}`);
    return z.kind === 'slope'
      ? { kind: 'slope', points, downhill: normalizeDownhill(z.downhill), grade: z.grade }
      : { kind: 'thick', points };
  });
  return {
    id: raw.id,
    name: raw.name,
    order: raw.order,
    customer: raw.customer,
    challenge: raw.challenge,
    tip: raw.tip,
    width: raw.width,
    height: raw.height,
    cellSize: raw.cellSize ?? 4,
    start: raw.start,
    property: toPolygon(raw.property, `${where} property`),
    pavement,
    obstacles: raw.obstacles.map((o, i) => toObstacle(o, `${where} obstacle #${i}`)),
    zones,
  };
}
