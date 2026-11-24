import type { JobResult } from '../sim/score';

export type Tool = 'start' | 'line' | 'curve' | 'freehand' | 'stripes' | 'edge';
export type Mode = 'edit' | 'mowing' | 'results';
export type Overlay = 'normal' | 'missed' | 'heat';
export type Command = 'undo' | 'redo' | 'clear' | 'mow' | 'stop' | 'edit';

export const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  {
    id: 'start',
    label: 'Start',
    key: 's',
    hint: 'Pick where you unload the mower: click a driveway, sidewalk or street.',
  },
  {
    id: 'line',
    label: 'Straight',
    key: '1',
    hint: 'Click to place a straight run. Snaps to corners, edges and your last point. Shift locks angles to 15°.',
  },
  {
    id: 'curve',
    label: 'Curve',
    key: '2',
    hint: 'Click the end point, then move to bend the curve and click again.',
  },
  {
    id: 'freehand',
    label: 'Freehand',
    key: '3',
    hint: 'Click and drag to draw. The line is smoothed when you let go.',
  },
  {
    id: 'stripes',
    label: 'Stripes',
    key: '4',
    hint: 'Click to set the first pass, then move sideways to add stripes and click.',
  },
  {
    id: 'edge',
    label: 'Edge',
    key: '5',
    hint: 'Drag along a house, bed, tree or the property line. The path sticks to the edge until you pull away.',
  },
];

/** Game seconds per real second at each playback speed. */
export const PLAYBACK_RATES = [10, 20, 40, 80];

export interface EditorState {
  yardName: string;
  mowerName: string;
  tool: Tool;
  snap: boolean;
  mode: Mode;
  overlay: Overlay;
  playback: number;
  canUndo: boolean;
  canRedo: boolean;
  segments: number;
  estimate: JobResult | null;
  live: { time: number; coverage: number } | null;
  result: JobResult | null;
}

type Listener = (s: EditorState) => void;
type CommandListener = (c: Command) => void;

export class EditorStore {
  private listeners: Listener[] = [];
  private commandListeners: CommandListener[] = [];

  constructor(public state: EditorState) {}

  set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  subscribe(l: Listener): void {
    this.listeners.push(l);
    l(this.state);
  }

  command(c: Command): void {
    for (const l of this.commandListeners) l(c);
  }

  onCommand(l: CommandListener): void {
    this.commandListeners.push(l);
  }
}

export function formatTime(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
