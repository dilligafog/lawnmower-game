import Phaser from 'phaser';
import type { Overlay } from '../state/editor';
import type { MowSession } from '../sim/simulation';
import {
  CELL_ASPHALT,
  CELL_BED,
  CELL_EDGE,
  CELL_FLOWERS,
  CELL_GRASS,
  CELL_NEIGHBOR,
  CELL_NONE,
  CELL_PAVEMENT,
  CELL_SOLID,
  CELL_TREE,
  type Yard,
} from '../sim/yard';
import { pointInPolygon } from '../sim/vec';

type RGB = [number, number, number];

const TALL: RGB = [52, 112, 44];
/** Overgrown: darker and shaggier. */
const THICK: RGB = [38, 92, 34];
/** Thick grass after one pass: knocked down but not clean yet. */
const ROUGH: RGB = [96, 142, 62];
/** Needs a trimmer (along fences). */
const TRIM: RGB = [232, 168, 48];
const CUT_LIGHT: RGB = [128, 196, 92];
const CUT_DARK: RGB = [88, 160, 66];
const MISSED: RGB = [214, 64, 58];
const HEAT: RGB[] = [MISSED, [92, 176, 92], [232, 200, 64], [236, 120, 48]];
const STATIC: Record<number, RGB> = {
  [CELL_NONE]: [30, 30, 30],
  [CELL_BED]: [104, 72, 44],
  [CELL_FLOWERS]: [96, 66, 42],
  [CELL_EDGE]: TALL,
  [CELL_TREE]: [86, 70, 46],
  [CELL_SOLID]: [120, 120, 120],
  [CELL_PAVEMENT]: [176, 172, 162],
  [CELL_ASPHALT]: [72, 74, 78],
  // Neighbors' lawns: a duller, bluer green so the customer's lot stands out.
  [CELL_NEIGHBOR]: [66, 98, 70],
};

/**
 * Draws the coverage grid into a canvas texture at one pixel per cell,
 * scaled up with nearest-neighbour filtering. Only dirty cells are rewritten
 * during playback.
 */
export class LawnRenderer {
  private tex: Phaser.Textures.CanvasTexture;
  private image: ImageData;
  private noise: Float32Array;
  /** Per-cell brightness offset: hills are lighter at the top, darker at the bottom. */
  private relief: Float32Array;
  readonly sprite: Phaser.GameObjects.Image;

  constructor(
    scene: Phaser.Scene,
    private yard: Yard,
  ) {
    const key = `lawn-${yard.def.id}`;
    if (scene.textures.exists(key)) scene.textures.remove(key);
    this.tex = scene.textures.createCanvas(key, yard.cols, yard.rows)!;
    this.tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.image = this.tex.context.createImageData(yard.cols, yard.rows);
    // Deterministic per-cell noise so grass looks textured but stable.
    this.noise = new Float32Array(yard.cols * yard.rows);
    let seed = 1337;
    for (let i = 0; i < this.noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      this.noise[i] = seed / 0xffffffff - 0.5;
    }
    this.relief = new Float32Array(yard.cols * yard.rows);
    for (const z of yard.def.zones) {
      if (z.kind !== 'slope') continue;
      const proj = z.points.map((p) => p.x * z.downhill.x + p.y * z.downhill.y);
      const lo = Math.min(...proj);
      const span = Math.max(...proj) - lo || 1;
      for (let r = 0; r < yard.rows; r++) {
        for (let c = 0; c < yard.cols; c++) {
          const p = { x: (c + 0.5) * yard.cellSize, y: (r + 0.5) * yard.cellSize };
          if (!pointInPolygon(p, z.points)) continue;
          const t = (p.x * z.downhill.x + p.y * z.downhill.y - lo) / span;
          this.relief[r * yard.cols + c] = 14 - t * 28;
        }
      }
    }
    this.sprite = scene.add.image(0, 0, key).setOrigin(0).setScale(yard.cellSize);
  }

  private color(idx: number, session: MowSession | null, overlay: Overlay): RGB {
    const type = this.yard.cells[idx];
    if (type === CELL_EDGE && session && overlay !== 'normal') return TRIM;
    if (type !== CELL_GRASS) return STATIC[type];
    const passes = session ? session.passes[idx] : 0;
    const need = this.yard.need[idx];
    if (session && overlay === 'heat') return HEAT[Math.min(passes, 3)];
    if (passes < need) {
      if (session && overlay === 'missed') return MISSED;
      if (passes > 0) return ROUGH;
      return need > 1 ? THICK : TALL;
    }
    return session!.shade[idx] > 0 ? CUT_LIGHT : CUT_DARK;
  }

  private write(idx: number, session: MowSession | null, overlay: Overlay): void {
    const [r, g, b] = this.color(idx, session, overlay);
    const type = this.yard.cells[idx];
    const passes = session ? session.passes[idx] : 0;
    // Tall grass is noisier than freshly cut grass; overgrown grass noisiest.
    const uncut = (type === CELL_GRASS && passes < this.yard.need[idx]) || type === CELL_EDGE;
    const amp = uncut ? (this.yard.need[idx] > 1 ? 34 : 22) : type === CELL_NEIGHBOR ? 22 : 10;
    const onLawn = type === CELL_GRASS || type === CELL_EDGE;
    const n = this.noise[idx] * amp + (onLawn ? this.relief[idx] : 0);
    const o = idx * 4;
    const d = this.image.data;
    d[o] = r + n;
    d[o + 1] = g + n;
    d[o + 2] = b + n;
    d[o + 3] = 255;
  }

  drawAll(session: MowSession | null, overlay: Overlay = 'normal'): void {
    for (let i = 0; i < this.noise.length; i++) this.write(i, session, overlay);
    this.flush();
  }

  drawCells(cells: number[], session: MowSession, overlay: Overlay = 'normal'): void {
    if (cells.length === 0) return;
    for (const i of cells) this.write(i, session, overlay);
    this.flush();
  }

  private flush(): void {
    this.tex.context.putImageData(this.image, 0, 0);
    this.tex.refresh();
  }
}
