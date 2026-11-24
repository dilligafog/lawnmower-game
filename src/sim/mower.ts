export interface MowerSpec {
  name: string;
  /** Cutting width in world units (px). */
  deckWidth: number;
  /** Straight-line speed in px per game second. */
  topSpeed: number;
  /** Extra seconds spent per radian of heading change. */
  turnTimePerRad: number;
  /** Tightest comfortable turn radius; turning tighter than this costs extra (pivoting, backing up). */
  minTurnRadius: number;
}

export const STARTER_MOWER: MowerSpec = {
  name: 'Hand-me-down push mower',
  deckWidth: 32,
  topSpeed: 45,
  turnTimePerRad: 0.45,
  minTurnRadius: 14,
};

/** Rough world scale for display: 10 px = 1 ft. */
export const PX_PER_FOOT = 10;
