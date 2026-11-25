import { type MowerSpec } from './mower';
import { type Route } from './route';
import { type DamageEvent, MowSession } from './simulation';
import { type HitKind, type Yard } from './yard';

export interface JobResult {
  coverage: number;
  grassCells: number;
  cutCells: number;
  missedCells: number;
  /** Game seconds. */
  time: number;
  turnTime: number;
  /** Time a perfect, zero-overlap, zero-turn mow would take. */
  idealTime: number;
  /** idealTime / time, 0..1. Real-world great routes land around 0.7-0.8. */
  efficiency: number;
  /** Average extra passes per cut cell (0 = no overlap). */
  overlap: number;
  distance: number;
  damage: DamageEvent[];
  /** Grass along fences the deck can't reach (needs a trimmer), in cells. */
  edgeCells: number;
  /** Customer satisfaction, 0..100. */
  satisfaction: number;
  /** Overall job score, 0..100. */
  score: number;
  stars: number;
}

/** Efficiency at or above this counts as "full marks" for speed. */
export const TARGET_EFFICIENCY = 0.75;
/** Satisfaction lost per incident, by what was hit. */
export const DAMAGE_PENALTY: Record<HitKind, number> = {
  tree: 15,
  bed: 8,
  flowers: 25,
  house: 20,
  rock: 15,
  fence: 15,
  toy: 12,
  hose: 12,
  bounds: 10,
  neighbor: 10,
};

export function scoreSession(session: MowSession): JobResult {
  const { yard, mower, timeline } = session;
  // Extra passes beyond what each cell needed, and the ideal time for the cells actually cut
  // (so skipping half the lawn doesn't look "efficient"; thick grass and hills cost more).
  let extraPasses = 0;
  let idealCost = 0;
  for (let i = 0; i < session.passes.length; i++) {
    const p = session.passes[i];
    const n = yard.need[i];
    if (p > n) extraPasses += p - n;
    if (n > 0 && p >= n) idealCost += yard.cost[i];
  }
  const cut = session.cutCells;
  const coverage = session.coverage;
  const idealTime =
    (idealCost * yard.cellSize * yard.cellSize) / (mower.deckWidth * mower.topSpeed);
  const time = timeline.totalTime;
  const efficiency = time > 0 ? Math.min(1, idealTime / time) : 0;

  // Customers barely notice the last couple of percent, but anything under ~80% is a fail.
  const coverageScore = Math.max(0, Math.min(1, (coverage - 0.8) / 0.18)) * 100;
  const penalty = session.damage.reduce((sum, d) => sum + DAMAGE_PENALTY[d.kind], 0);
  const satisfaction = Math.max(0, coverageScore - penalty);
  const speedScore = Math.min(1, efficiency / TARGET_EFFICIENCY) * 100;
  // A fast job that misses half the lawn should not score well: speed only counts in proportion to quality.
  const score = satisfaction * 0.6 + speedScore * 0.4 * (satisfaction / 100);
  const stars = Math.max(1, Math.min(5, Math.ceil(score / 20)));

  return {
    coverage,
    grassCells: yard.grassCount,
    cutCells: cut,
    missedCells: yard.grassCount - cut,
    time,
    turnTime: timeline.turnTime,
    idealTime,
    efficiency,
    overlap: cut > 0 ? extraPasses / cut : 0,
    distance: timeline.totalDist,
    damage: session.damage,
    edgeCells: yard.edgeCount,
    satisfaction,
    score,
    stars,
  };
}

/** Run a whole job headlessly (route preview estimates, crews, offline progress). */
export function simulateJob(yard: Yard, mower: MowerSpec, route: Route): JobResult {
  const session = new MowSession(yard, mower, route);
  session.runToEnd();
  return scoreSession(session);
}
