import { type Vec, closestOnSegment, dist, pointInPolygon } from './vec';

export type ObstacleKind = 'tree' | 'bed' | 'house' | 'rock';

export interface CircleObstacle {
  shape: 'circle';
  kind: ObstacleKind;
  x: number;
  y: number;
  r: number;
}

export interface PolygonObstacle {
  shape: 'polygon';
  kind: ObstacleKind;
  points: Vec[];
}

export type Obstacle = CircleObstacle | PolygonObstacle;

/** Static description of a yard, loaded from data files. */
export interface YardDef {
  id: string;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  start: Vec;
  /** Drivable, grass-free areas (driveway, sidewalk). */
  pavement: Vec[][];
  obstacles: Obstacle[];
}

export const CELL_NONE = 0;
export const CELL_GRASS = 1;
export const CELL_BED = 2;
export const CELL_TREE = 3;
export const CELL_SOLID = 4;
export const CELL_PAVEMENT = 5;

/** A yard rasterized into a coverage grid. */
export interface Yard {
  def: YardDef;
  cols: number;
  rows: number;
  cellSize: number;
  cells: Uint8Array;
  grassCount: number;
}

const KIND_CELL: Record<ObstacleKind, number> = {
  tree: CELL_TREE,
  bed: CELL_BED,
  house: CELL_SOLID,
  rock: CELL_SOLID,
};

/** Signed distance from p to the obstacle edge: negative inside. */
export function obstacleDistance(p: Vec, o: Obstacle): number {
  if (o.shape === 'circle') return Math.hypot(p.x - o.x, p.y - o.y) - o.r;
  let d = Infinity;
  const pts = o.points;
  for (let i = 0; i < pts.length; i++) {
    const { point } = closestOnSegment(p, pts[i], pts[(i + 1) % pts.length]);
    d = Math.min(d, dist(p, point));
  }
  return pointInPolygon(p, pts) ? -d : d;
}

export function buildYard(def: YardDef): Yard {
  const cs = def.cellSize;
  const cols = Math.ceil(def.width / cs);
  const rows = Math.ceil(def.height / cs);
  const cells = new Uint8Array(cols * rows);
  let grassCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { x: (c + 0.5) * cs, y: (r + 0.5) * cs };
      let type = CELL_GRASS;
      for (const o of def.obstacles) {
        if (obstacleDistance(p, o) <= 0) {
          type = KIND_CELL[o.kind];
          break;
        }
      }
      if (type === CELL_GRASS && def.pavement.some((poly) => pointInPolygon(p, poly))) {
        type = CELL_PAVEMENT;
      }
      if (type === CELL_GRASS) grassCount++;
      cells[r * cols + c] = type;
    }
  }
  return { def, cols, rows, cellSize: cs, cells, grassCount };
}

export type HitKind = ObstacleKind | 'fence';

/**
 * What the mower body would hit with its center at p. `body` is how far the
 * mower's solid body extends from its center (smaller than half the deck, since
 * the deck edge is allowed to brush right up against things).
 */
export function hitTest(yard: Yard, p: Vec, body: number): HitKind | null {
  const { width, height, obstacles } = yard.def;
  if (p.x < body || p.y < body || p.x > width - body || p.y > height - body) return 'fence';
  for (const o of obstacles) {
    if (obstacleDistance(p, o) < body) return o.kind;
  }
  return null;
}

export function obstacleAt(yard: Yard, p: Vec, within: number): Obstacle | null {
  let best: Obstacle | null = null;
  let bestD = within;
  for (const o of yard.def.obstacles) {
    const d = obstacleDistance(p, o);
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}
