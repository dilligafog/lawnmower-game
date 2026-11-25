import { type Vec, closestOnSegment, dist, dot, pointInPolygon } from './vec';

export type ObstacleKind = 'tree' | 'bed' | 'flowers' | 'house' | 'rock' | 'fence' | 'toy' | 'hose';

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
  /** For stroked obstacles (fences, hoses): the line they were drawn from, for rendering. */
  centerline?: Vec[];
}

export type Obstacle = CircleObstacle | PolygonObstacle;

/** concrete = driveways and sidewalks; asphalt = streets and parking lots. */
export type PavementKind = 'concrete' | 'asphalt';

export interface Pavement {
  kind: PavementKind;
  points: Vec[];
}

/**
 * Terrain that changes how the mower moves or cuts.
 * - slope: speed depends on direction (uphill slowest, across fastest).
 * - thick: overgrown grass; slower, and needs two passes to cut clean.
 */
export type Zone =
  { kind: 'slope'; points: Vec[]; downhill: Vec; grade: number } | { kind: 'thick'; points: Vec[] };

/** Static description of a yard and its surroundings, loaded from data files. */
export interface YardDef {
  id: string;
  name: string;
  /** Sort order in the job list. */
  order: number;
  customer: string;
  /** Short label for what this yard teaches. */
  challenge: string;
  tip: string;
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
  zones: Zone[];
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
/** Grass the deck can't reach (along fences): needs a trimmer, not counted as mowable. */
export const CELL_EDGE = 8;
export const CELL_FLOWERS = 9;

/** Width of the strip along a fence that only a trimmer can reach. */
export const TRIM_BAND = 6;

/** Thick grass: speed multiplier and passes needed for a clean cut. */
export const THICK_SPEED = 0.7;
export const THICK_PASSES = 2;

/** A yard rasterized into a coverage grid. */
export interface Yard {
  def: YardDef;
  cols: number;
  rows: number;
  cellSize: number;
  cells: Uint8Array;
  /** Passes needed for each grass cell to count as cut (1, or 2 in thick grass). */
  need: Uint8Array;
  /**
   * Best-case seconds-per-area multiplier for each cell (passes needed / best
   * speed factor there). Used for the "ideal time" a job is measured against.
   */
  cost: Float32Array;
  grassCount: number;
  edgeCount: number;
}

const KIND_CELL: Record<ObstacleKind, number> = {
  tree: CELL_TREE,
  bed: CELL_BED,
  flowers: CELL_FLOWERS,
  house: CELL_SOLID,
  rock: CELL_SOLID,
  fence: CELL_SOLID,
  toy: CELL_SOLID,
  hose: CELL_SOLID,
};

/**
 * Rigid things the deck itself can't overlap (it would hit them or chew them
 * up). Soft things (mulch, flowers, the mulch ring under a tree) only count
 * when the mower body drives into them.
 */
const RIGID: ReadonlySet<ObstacleKind> = new Set(['house', 'rock', 'fence', 'toy', 'hose']);

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

/** Speed for a slope: uphill costs the most, downhill a little, across the least. */
export function slopeFactor(downhill: Vec, grade: number, heading: number): number {
  const u = -dot({ x: Math.cos(heading), y: Math.sin(heading) }, downhill); // +1 = straight uphill
  const loss = 0.6 * Math.max(u, 0) + 0.2 * Math.max(-u, 0) + 0.15 * (1 - Math.abs(u));
  return 1 - grade * loss;
}

/** Terrain speed multiplier for the mower at p heading in direction `heading`. */
export function speedFactorAt(yard: Yard, p: Vec, heading: number): number {
  let f = 1;
  for (const z of yard.def.zones) {
    if (!pointInPolygon(p, z.points)) continue;
    f *= z.kind === 'thick' ? THICK_SPEED : slopeFactor(z.downhill, z.grade, heading);
  }
  return f;
}

export function buildYard(def: YardDef): Yard {
  const cs = def.cellSize;
  const cols = Math.ceil(def.width / cs);
  const rows = Math.ceil(def.height / cs);
  const size = cols * rows;
  const cells = new Uint8Array(size);
  const need = new Uint8Array(size);
  const cost = new Float32Array(size);
  const fences = def.obstacles.filter((o) => o.kind === 'fence');
  let grassCount = 0;
  let edgeCount = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
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
      if (type === CELL_GRASS && fences.some((f) => obstacleDistance(p, f) < TRIM_BAND)) {
        type = CELL_EDGE;
      }
      if (type === CELL_GRASS) {
        grassCount++;
        let n = 1;
        let best = 1;
        for (const z of def.zones) {
          if (!pointInPolygon(p, z.points)) continue;
          if (z.kind === 'thick') {
            n = THICK_PASSES;
            best *= THICK_SPEED;
          } else {
            best *= slopeFactor(z.downhill, z.grade, Math.atan2(z.downhill.x, -z.downhill.y));
          }
        }
        need[idx] = n;
        cost[idx] = n / best;
      } else if (type === CELL_EDGE) {
        edgeCount++;
      }
      cells[idx] = type;
    }
  }
  return { def, cols, rows, cellSize: cs, cells, need, cost, grassCount, edgeCount };
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

export type HitKind = ObstacleKind | 'bounds' | 'neighbor';

const RING = Array.from({ length: 8 }, (_, i) => ({
  x: Math.cos((i / 8) * Math.PI * 2),
  y: Math.sin((i / 8) * Math.PI * 2),
}));

/**
 * What the mower would hit with its center at p. Rigid obstacles must stay
 * clear of the whole deck (less a pixel of slack); soft ones only of the
 * mower's body (~30% of the deck from center, so the deck can hang over mulch).
 */
export function hitTest(yard: Yard, p: Vec, deckWidth: number): HitKind | null {
  const soft = deckWidth * 0.3;
  const rigid = deckWidth / 2 - 1;
  const { width, height, obstacles } = yard.def;
  if (p.x < soft || p.y < soft || p.x > width - soft || p.y > height - soft) return 'bounds';
  for (const o of obstacles) {
    if (obstacleDistance(p, o) < (RIGID.has(o.kind) ? rigid : soft)) return o.kind;
  }
  if (cellAt(yard, p) === CELL_NEIGHBOR) return 'neighbor';
  for (const d of RING) {
    if (cellAt(yard, { x: p.x + d.x * soft, y: p.y + d.y * soft }) === CELL_NEIGHBOR) {
      return 'neighbor';
    }
  }
  return null;
}
