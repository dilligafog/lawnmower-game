import Phaser from 'phaser';
import type { Overlay } from '../state/editor';
import type { MowSession } from '../sim/simulation';
import {
  CELL_ASPHALT,
  CELL_BED,
  CELL_GRASS,
  CELL_NEIGHBOR,
  CELL_NONE,
  CELL_PAVEMENT,
  CELL_SOLID,
  CELL_TREE,
  type Yard,
} from '../sim/yard';

type RGB = [number, number, number];

const TALL: RGB = [52, 112, 44];
const CUT_LIGHT: RGB = [128, 196, 92];
const CUT_DARK: RGB = [88, 160, 66];
const MISSED: RGB = [214, 64, 58];
const HEAT: RGB[] = [MISSED, [92, 176, 92], [232, 200, 64], [236, 120, 48]];
const STATIC: Record<number, RGB> = {
  [CELL_NONE]: [30, 30, 30],
  [CELL_BED]: [104, 72, 44],
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
    this.sprite = scene.add.image(0, 0, key).setOrigin(0).setScale(yard.cellSize);
  }

  private color(idx: number, session: MowSession | null, overlay: Overlay): RGB {
    const type = this.yard.cells[idx];
    if (type !== CELL_GRASS) return STATIC[type];
    const passes = session ? session.passes[idx] : 0;
    if (session && overlay === 'heat') return HEAT[Math.min(passes, 3)];
    if (passes === 0) return session && overlay === 'missed' ? MISSED : TALL;
    return session!.shade[idx] > 0 ? CUT_LIGHT : CUT_DARK;
  }

  private write(idx: number, session: MowSession | null, overlay: Overlay): void {
    const [r, g, b] = this.color(idx, session, overlay);
    const type = this.yard.cells[idx];
    const passes = session ? session.passes[idx] : 0;
    // Tall grass is noisier than freshly cut grass.
    const amp = (type === CELL_GRASS && passes === 0) || type === CELL_NEIGHBOR ? 22 : 10;
    const n = this.noise[idx] * amp;
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
