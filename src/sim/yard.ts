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

/** concrete = driveways and sidewalks; asphalt = streets and parking lots. */
export type PavementKind = 'concrete' | 'asphalt';

export interface Pavement {
  kind: PavementKind;
  points: Vec[];
}

/** Static description of a yard and its surroundings, loaded from data files. */
export interface YardDef {
  id: string;
  name: string;
  /** World size, including the street and neighbors around the lot. */
  width: number;
  height: number;
  cellSize: number;
  /** Default place to unload the mower; the player can pick any pavement. */
  start: Vec;
  /** The customer's lot. Grass outside it belongs to the neighbors. */
  property: Vec[];
  /** Drivable, grass-free areas. Any of them is a valid start point. */
  pavement: Pavement[];
  obstacles: Obstacle[];
}

export const CELL_NONE = 0;
export const CELL_GRASS = 1;
export const CELL_BED = 2;
export const CELL_TREE = 3;
export const CELL_SOLID = 4;
export const CELL_PAVEMENT = 5;
export const CELL_ASPHALT = 6;
/** Grass on someone else's property: not ours to mow, and driving on it is a complaint. */
export const CELL_NEIGHBOR = 7;

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
  return polygonDistance(p, o.points);
}

export function polygonDistance(p: Vec, pts: Vec[]): number {
  let d = Infinity;
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
      let type = -1;
      for (const o of def.obstacles) {
        if (obstacleDistance(p, o) <= 0) {
          type = KIND_CELL[o.kind];
          break;
        }
      }
      if (type < 0) {
        const pave = def.pavement.find((pv) => pointInPolygon(p, pv.points));
        if (pave) type = pave.kind === 'asphalt' ? CELL_ASPHALT : CELL_PAVEMENT;
      }
      if (type < 0) type = pointInPolygon(p, def.property) ? CELL_GRASS : CELL_NEIGHBOR;
      if (type === CELL_GRASS) grassCount++;
      cells[r * cols + c] = type;
    }
  }
  return { def, cols, rows, cellSize: cs, cells, grassCount };
}

export function cellAt(yard: Yard, p: Vec): number {
  const c = Math.floor(p.x / yard.cellSize);
  const r = Math.floor(p.y / yard.cellSize);
  if (c < 0 || r < 0 || c >= yard.cols || r >= yard.rows) return CELL_NONE;
  return yard.cells[r * yard.cols + c];
}

/** Where the mower can be unloaded: driveways, sidewalks, streets, parking lots. */
export function isValidStart(yard: Yard, p: Vec): boolean {
  const t = cellAt(yard, p);
  return t === CELL_PAVEMENT || t === CELL_ASPHALT;
}

export type HitKind = ObstacleKind | 'fence' | 'neighbor';

const RING = Array.from({ length: 8 }, (_, i) => ({
  x: Math.cos((i / 8) * Math.PI * 2),
  y: Math.sin((i / 8) * Math.PI * 2),
}));

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
  if (cellAt(yard, p) === CELL_NEIGHBOR) return 'neighbor';
  for (const d of RING) {
    if (cellAt(yard, { x: p.x + d.x * body, y: p.y + d.y * body }) === CELL_NEIGHBOR) {
      return 'neighbor';
    }
  }
  return null;
}
