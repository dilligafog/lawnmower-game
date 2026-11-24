import Phaser from 'phaser';
import { LawnRenderer } from './LawnRenderer';
import { type EditorStore, PLAYBACK_RATES, TOOLS, type Tool } from '../state/editor';
import { type MowerSpec } from '../sim/mower';
import {
  type Route,
  type Segment,
  curveControlThrough,
  quadBezier,
  routeEnd,
  routePolyline,
  resample,
  sideOf,
  smoothStroke,
  stripeFill,
  catmullRom,
} from '../sim/route';
import { scoreSession, simulateJob } from '../sim/score';
import { MowSession } from '../sim/simulation';
import { DEFAULT_SNAP, Snapper, type SnapResult, snapAngle } from '../sim/snap';
import { type Vec, dist, sub, norm } from '../sim/vec';
import { type Yard, buildYard, isValidStart, type YardDef } from '../sim/yard';

const COLORS = {
  route: 0xffffff,
  preview: 0xf2c14e,
  guide: 0xffffff,
  snapEdge: 0x4fd8ff,
  snapCorner: 0x4fd8ff,
  snapAxis: 0xb388ff,
  snapGrid: 0xffffff,
  snapPoint: 0xff9f43,
  startOk: 0x4caf50,
  startBad: 0xe53935,
  property: 0xffffff,
  house: 0x8a5a44,
  roof: 0x6e4535,
  trunk: 0x5b3a1e,
  canopy: 0x2d5a27,
  flowers: [0xf06292, 0xffd54f, 0xba68c8, 0xffffff],
};

/** Stripe spacing as a fraction of deck width: ~10% overlap between passes, like the pros. */
const STRIPE_OVERLAP = 0.9;

interface SceneData {
  yard: YardDef;
  mower: MowerSpec;
  store: EditorStore;
}

type Pending =
  | { tool: 'curve'; end: Vec }
  | { tool: 'stripes'; b: Vec }
  | { tool: 'freehand' | 'edge'; stroke: Vec[] }
  | null;

export class MowScene extends Phaser.Scene {
  private yard!: Yard;
  private mower!: MowerSpec;
  private store!: EditorStore;
  private snapper!: Snapper;
  private lawn!: LawnRenderer;

  private route!: Route;
  private past: Route[] = [];
  private future: Route[] = [];
  private pending: Pending = null;
  private cursor: Vec = { x: 0, y: 0 };
  private snapped: SnapResult | null = null;
  private shift = false;

  private guideGfx!: Phaser.GameObjects.Graphics;
  private swathGfx!: Phaser.GameObjects.Graphics;
  private swathRT!: Phaser.GameObjects.RenderTexture;
  private routeGfx!: Phaser.GameObjects.Graphics;
  private previewGfx!: Phaser.GameObjects.Graphics;
  private mowerSprite!: Phaser.GameObjects.Image;

  private session: MowSession | null = null;

  constructor() {
    super('mow');
  }

  init(data: SceneData): void {
    this.yard = buildYard(data.yard);
    this.mower = data.mower;
    this.store = data.store;
    this.snapper = new Snapper(this.yard, { ...DEFAULT_SNAP, deckWidth: this.mower.deckWidth });
    this.route = this.loadRoute();
  }

  create(): void {
    const { width, height } = this.yard.def;
    this.lawn = new LawnRenderer(this, this.yard);
    this.lawn.drawAll(null);
    this.drawStaticYard(false);

    this.guideGfx = this.add.graphics();
    this.drawGuides();
    this.swathGfx = this.make.graphics({}, false);
    this.swathRT = this.add.renderTexture(0, 0, width, height).setOrigin(0).setAlpha(0.22);
    this.routeGfx = this.add.graphics();
    this.previewGfx = this.add.graphics();
    this.mowerSprite = this.add.image(0, 0, this.makeMowerTexture()).setVisible(false);
    this.drawStaticYard(true);

    this.input.mouse?.disableContextMenu();
    this.input.on('pointermove', this.onPointerMove, this);
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointerup', this.onPointerUp, this);
    this.input.keyboard?.on('keydown', this.onKey, this);
    this.input.keyboard?.on('keyup', (e: KeyboardEvent) => {
      if (e.key === 'Shift') this.shift = false;
    });

    this.store.onCommand((c) => {
      if (c === 'undo') this.undo();
      else if (c === 'redo') this.redo();
      else if (c === 'clear') this.commit({ ...this.route, segments: [] });
      else if (c === 'mow') this.startMowing();
      else if (c === 'stop' || c === 'edit') this.backToEdit();
    });
    let lastOverlay = this.store.state.overlay;
    let lastTool = this.store.state.tool;
    this.store.subscribe((s) => {
      if (s.overlay !== lastOverlay) {
        lastOverlay = s.overlay;
        if (this.session) this.lawn.drawAll(this.session, s.overlay);
      }
      if (s.tool !== lastTool) {
        lastTool = s.tool;
        this.pending = null;
        this.drawPreview();
      }
    });

    // A fresh yard starts by choosing where to unload the mower.
    if (this.route.segments.length === 0) this.store.set({ tool: 'start' });
    this.routeChanged();
  }

  // ---------------------------------------------------------------- editing

  private get tool(): Tool {
    return this.store.state.tool;
  }

  private get editing(): boolean {
    return this.store.state.mode === 'edit';
  }

  private commit(route: Route): void {
    this.past.push(this.route);
    this.future = [];
    this.route = route;
    this.routeChanged();
  }

  private addSegment(seg: Segment): void {
    this.commit({ ...this.route, segments: [...this.route.segments, seg] });
  }

  /** Move the start point; the first segment is re-anchored so the route stays connected. */
  private setStart(p: Vec): void {
    const [first, ...rest] = this.route.segments;
    let segments = this.route.segments;
    if (first && (first.kind === 'spline' || first.kind === 'polyline')) {
      segments = [{ ...first, points: [p, ...first.points.slice(1)] }, ...rest];
    }
    this.commit({ start: p, segments });
    if (segments.length === 0) this.store.set({ tool: 'line' });
  }

  private undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.route);
    this.route = prev;
    this.pending = null;
    this.routeChanged();
  }

  private redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.route);
    this.route = next;
    this.routeChanged();
  }

  private routeChanged(): void {
    this.saveRoute();
    this.drawRoute();
    this.drawPreview();
    const has = this.route.segments.length > 0;
    this.store.set({
      segments: this.route.segments.length,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      estimate: has ? simulateJob(this.yard, this.mower, this.route) : null,
    });
  }

  private snapPoint(p: Vec, allowGrid = true): Vec {
    const end = routeEnd(this.route);
    const anchors = [this.route.start, end];
    this.snapped = this.snapper.snap(p, allowGrid && this.store.state.snap, anchors, end);
    let out = this.snapped.point;
    if (this.shift && (this.tool === 'line' || this.tool === 'stripes')) {
      const free = this.snapped.kind === 'none' || this.snapped.kind === 'grid';
      out = snapAngle(end, free || this.snapped.kind === 'axis' ? p : out);
      this.snapped = { point: out, kind: 'none' };
    }
    return out;
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    this.cursor = { x: pointer.worldX, y: pointer.worldY };
    this.shift = pointer.event?.shiftKey ?? false;
    if (!this.editing) return;
    if (this.pending?.tool === 'freehand' || this.pending?.tool === 'edge') {
      const last = this.pending.stroke[this.pending.stroke.length - 1];
      if (dist(last, this.cursor) >= 2) this.pending.stroke.push(this.cursor);
    }
    this.drawPreview();
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (!this.editing) return;
    if (pointer.rightButtonDown()) {
      this.pending = null;
      this.drawPreview();
      return;
    }
    this.shift = pointer.event?.shiftKey ?? false;
    const end = routeEnd(this.route);
    const raw = { x: pointer.worldX, y: pointer.worldY };
    switch (this.tool) {
      case 'start':
        if (isValidStart(this.yard, raw)) this.setStart(raw);
        break;
      case 'line': {
        const p = this.snapPoint(raw);
        if (dist(p, end) > 2) this.addSegment({ kind: 'line', to: p });
        break;
      }
      case 'curve': {
        if (this.pending?.tool !== 'curve') {
          const p = this.snapPoint(raw);
          if (dist(p, end) > 4) this.pending = { tool: 'curve', end: p };
        } else {
          const to = this.pending.end;
          const control = curveControlThrough(end, to, this.snapPoint(raw, false));
          this.pending = null;
          this.addSegment({ kind: 'curve', control, to });
        }
        break;
      }
      case 'freehand':
      case 'edge':
        this.pending = { tool: this.tool, stroke: [raw] };
        break;
      case 'stripes': {
        if (this.pending?.tool !== 'stripes') {
          const p = this.snapPoint(raw);
          if (dist(p, end) > this.mower.deckWidth) this.pending = { tool: 'stripes', b: p };
        } else {
          const pts = this.stripePreview(this.pending.b, raw);
          this.pending = null;
          this.addSegment({ kind: 'polyline', points: pts });
        }
        break;
      }
    }
    this.drawPreview();
  }

  private onPointerUp(): void {
    if (!this.editing) return;
    const pending = this.pending;
    if (pending?.tool !== 'freehand' && pending?.tool !== 'edge') return;
    this.pending = null;
    const end = routeEnd(this.route);
    if (pending.tool === 'edge') {
      const pts = this.snapper.stickyPath(pending.stroke);
      if (pts.length >= 2) this.addSegment({ kind: 'polyline', points: [end, ...pts] });
    } else {
      const pts = smoothStroke(pending.stroke);
      // Chain from the route end; skip the stroke's first point if it started right there.
      const chained = dist(pts[0], end) < 10 ? [end, ...pts.slice(1)] : [end, ...pts];
      if (chained.length >= 2 && dist(chained[0], chained[chained.length - 1]) + pts.length > 12) {
        this.addSegment({ kind: 'spline', points: chained });
      }
    }
    this.drawPreview();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Shift') {
      this.shift = true;
      this.drawPreview();
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.store.command('redo');
      else this.store.command('undo');
    } else if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.store.command('redo');
    } else if (e.key === 'Escape') {
      this.pending = null;
      this.drawPreview();
    } else if (e.key === 'Enter' && this.route.segments.length > 0) {
      this.store.command('mow');
    } else if (this.editing && !ctrl) {
      const t = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (t) this.store.set({ tool: t.id });
    }
  }

  private stripePreview(b: Vec, cursor: Vec): Vec[] {
    const a = routeEnd(this.route);
    const spacing = this.mower.deckWidth * STRIPE_OVERLAP;
    const off = dist(cursor, closestOnLine(cursor, a, b));
    const count = 1 + Math.floor((off + spacing * 0.5) / spacing);
    return stripeFill(a, b, sideOf(a, b, cursor), count, spacing);
  }

  // ---------------------------------------------------------------- drawing

  private drawStaticYard(overlayLayer: boolean): void {
    const g = this.add.graphics();
    g.setDepth(overlayLayer ? 50 : 0);
    if (!overlayLayer) {
      // Property line: dashed survey line around the customer's lot.
      dashedLoop(g, this.yard.def.property, 0xffffff, 0.55, 2, 10, 7);
    }
    for (const o of this.yard.def.obstacles) {
      if (overlayLayer) {
        // Tree canopies are drawn above the route and mower for a bit of depth.
        if (o.shape === 'circle' && o.kind === 'tree') {
          g.fillStyle(COLORS.canopy, 0.55).fillCircle(o.x, o.y, o.r * 1.5);
          g.fillStyle(COLORS.canopy, 0.5).fillCircle(o.x - o.r * 0.3, o.y - o.r * 0.3, o.r * 0.9);
        }
        continue;
      }
      if (o.shape === 'circle') {
        g.fillStyle(COLORS.trunk).fillCircle(o.x, o.y, o.r * 0.35);
      } else if (o.kind === 'house') {
        g.fillStyle(COLORS.house).fillPoints(o.points, true);
        const xs = o.points.map((p) => p.x);
        const ys = o.points.map((p) => p.y);
        const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
        g.lineStyle(3, COLORS.roof).lineBetween(Math.min(...xs), midY, Math.max(...xs), midY);
        g.lineStyle(2, COLORS.roof).strokePoints(o.points, true);
      } else if (o.kind === 'bed') {
        // Deterministic flowers scattered inside the bed.
        const xs = o.points.map((p) => p.x);
        const ys = o.points.map((p) => p.y);
        let seed = Math.round(xs[0] * 31 + ys[0]);
        const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0xffffffff;
        const poly = new Phaser.Geom.Polygon(o.points.map((p) => new Phaser.Geom.Point(p.x, p.y)));
        for (let i = 0; i < 400; i++) {
          const x = Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs));
          const y = Math.min(...ys) + rnd() * (Math.max(...ys) - Math.min(...ys));
          if (!poly.contains(x, y)) continue;
          g.fillStyle(COLORS.flowers[Math.floor(rnd() * COLORS.flowers.length)]).fillCircle(
            x,
            y,
            2.5,
          );
        }
      }
    }
  }

  /** Faint snap guides: the edge lines (half a deck off every obstacle) and their corners. */
  private drawGuides(): void {
    const g = this.guideGfx;
    for (const guide of this.snapper.guides) {
      g.lineStyle(1, COLORS.guide, 0.18).strokePoints(guide.loop);
    }
    for (const c of this.snapper.corners) {
      g.fillStyle(COLORS.guide, 0.35).fillCircle(c.x, c.y, 2.5);
    }
  }

  private drawRoute(): void {
    const g = this.routeGfx;
    g.clear();
    this.swathGfx.clear();
    this.swathRT.clear();
    const start = this.route.start;
    g.fillStyle(COLORS.startOk)
      .fillCircle(start.x, start.y, 7)
      .lineStyle(2, 0xffffff)
      .strokeCircle(start.x, start.y, 7);
    if (this.route.segments.length === 0) return;

    const poly = routePolyline(this.route);
    // Deck footprint: opaque circles into a render texture, shown semi-transparent (no alpha build-up).
    this.swathGfx.fillStyle(COLORS.route, 1);
    for (const p of resample(poly, 4)) this.swathGfx.fillCircle(p.x, p.y, this.mower.deckWidth / 2);
    this.swathRT.draw(this.swathGfx);

    g.lineStyle(2, COLORS.route, 0.9).strokePoints(poly);
    // Direction chevrons along the route.
    const marks = resample(poly, 48);
    for (let i = 1; i < marks.length - 1; i++) {
      const d = norm(sub(marks[i + 1], marks[i - 1]));
      const p = marks[i];
      const s = 5;
      g.lineStyle(2, COLORS.route, 0.9);
      g.lineBetween(p.x, p.y, p.x - d.x * s - d.y * s, p.y - d.y * s + d.x * s);
      g.lineBetween(p.x, p.y, p.x - d.x * s + d.y * s, p.y - d.y * s - d.x * s);
    }
    const end = routeEnd(this.route);
    g.fillStyle(0xe53935).fillCircle(end.x, end.y, 6);
  }

  private drawPreview(): void {
    const g = this.previewGfx;
    g.clear();
    this.guideGfx.setVisible(this.editing);
    if (!this.editing) return;
    const end = routeEnd(this.route);
    const deck = this.mower.deckWidth;
    let pts: Vec[] = [];
    this.snapped = null;

    switch (this.tool) {
      case 'start': {
        const ok = isValidStart(this.yard, this.cursor);
        const c = ok ? COLORS.startOk : COLORS.startBad;
        g.lineStyle(2, c, 1).strokeCircle(this.cursor.x, this.cursor.y, 9);
        if (!ok) {
          g.lineBetween(this.cursor.x - 6, this.cursor.y - 6, this.cursor.x + 6, this.cursor.y + 6);
        }
        return;
      }
      case 'line':
        pts = [end, this.snapPoint(this.cursor)];
        break;
      case 'curve':
        if (this.pending?.tool === 'curve') {
          const through = this.snapPoint(this.cursor, false);
          const c = curveControlThrough(end, this.pending.end, through);
          const to = this.pending.end;
          pts = Array.from({ length: 33 }, (_, i) => quadBezier(end, c, to, i / 32));
        } else {
          pts = [end, this.snapPoint(this.cursor)];
        }
        break;
      case 'freehand':
        if (this.pending?.tool === 'freehand') pts = catmullRom(smoothStroke(this.pending.stroke));
        break;
      case 'edge': {
        if (this.pending?.tool === 'edge') {
          pts = [end, ...this.snapper.stickyPath(this.pending.stroke)];
        } else {
          // Show which edge the stroke would stick to.
          const pr = this.snapper.project(this.cursor, DEFAULT_SNAP.edgeRadius);
          if (pr) {
            g.lineStyle(2, COLORS.snapEdge, 0.5).strokePoints(this.snapper.guides[pr.guide].loop);
            this.snapped = { point: pr.point, kind: 'edge' };
          }
        }
        break;
      }
      case 'stripes':
        pts =
          this.pending?.tool === 'stripes'
            ? this.stripePreview(this.pending.b, this.cursor)
            : [end, this.snapPoint(this.cursor)];
        if (this.pending?.tool === 'stripes') this.snapped = null;
        break;
    }

    if (pts.length >= 2) {
      g.lineStyle(deck, COLORS.preview, 0.12).strokePoints(pts);
      g.lineStyle(2, COLORS.preview, 1).strokePoints(pts);
    }
    const s = this.snapped;
    if (s) {
      const { x, y } = s.point;
      if (s.kind === 'corner') {
        g.lineStyle(2, COLORS.snapCorner, 1).strokeRect(x - 6, y - 6, 12, 12);
        g.fillStyle(COLORS.snapCorner, 1).fillCircle(x, y, 3);
      } else if (s.kind === 'axis' && s.alignedWith) {
        const a = s.alignedWith;
        dashedLine(g, a, s.point, COLORS.snapAxis, 0.9, 1.5, 6, 5);
        g.fillStyle(COLORS.snapAxis, 1).fillCircle(x, y, 4);
      } else {
        const color =
          s.kind === 'edge'
            ? COLORS.snapEdge
            : s.kind === 'point'
              ? COLORS.snapPoint
              : COLORS.snapGrid;
        g.fillStyle(color, 1).fillCircle(x, y, 4);
      }
    }
  }

  private makeMowerTexture(): string {
    const key = 'mower';
    if (this.textures.exists(key)) return key;
    const deck = this.mower.deckWidth;
    const len = Math.round(deck * 0.8);
    const handle = 14;
    const g = this.make.graphics({}, false);
    // Facing +x: handle trails behind (left), deck in front.
    g.lineStyle(3, 0x333333).lineBetween(0, deck * 0.3, handle + 4, deck * 0.3);
    g.lineBetween(0, deck * 0.7, handle + 4, deck * 0.7);
    g.lineBetween(1, deck * 0.3, 1, deck * 0.7);
    g.fillStyle(0xc62828).fillRoundedRect(handle, 0, len, deck, 5);
    g.fillStyle(0x424242).fillCircle(handle + len / 2, deck / 2, deck * 0.22);
    g.fillStyle(0x9e9e9e).fillCircle(handle + len / 2, deck / 2, deck * 0.1);
    g.generateTexture(key, handle + len, deck);
    g.destroy();
    return key;
  }

  // ---------------------------------------------------------------- mowing

  private startMowing(): void {
    if (this.route.segments.length === 0) return;
    this.pending = null;
    this.session = new MowSession(this.yard, this.mower, this.route);
    this.lawn.drawAll(this.session);
    this.routeGfx.setAlpha(0.25);
    this.swathRT.setVisible(false);
    this.mowerSprite
      .setVisible(true)
      .setOrigin(1 - (this.mower.deckWidth * 0.4) / this.mowerSprite.width, 0.5);
    this.store.set({
      mode: 'mowing',
      overlay: 'normal',
      result: null,
      live: { time: 0, coverage: 0 },
    });
    this.drawPreview();
  }

  private backToEdit(): void {
    this.session = null;
    this.lawn.drawAll(null);
    this.routeGfx.setAlpha(1);
    this.swathRT.setVisible(true);
    this.mowerSprite.setVisible(false);
    this.store.set({ mode: 'edit', overlay: 'normal', live: null, result: null });
    this.drawPreview();
  }

  update(_time: number, delta: number): void {
    const s = this.session;
    if (!s || this.store.state.mode !== 'mowing') return;
    const rate = PLAYBACK_RATES[this.store.state.playback];
    s.advanceTo(s.time + (delta / 1000) * rate);
    this.lawn.drawCells(s.dirty, s);
    s.dirty = [];
    const { pos, heading } = s.pose();
    this.mowerSprite.setPosition(pos.x, pos.y).setRotation(heading);
    this.store.set({ live: { time: s.time, coverage: s.coverage } });
    if (s.done) {
      this.store.set({ mode: 'results', result: scoreSession(s) });
    }
  }

  // ---------------------------------------------------------------- persistence

  private get storageKey(): string {
    return `lawnpro.v2.route.${this.yard.def.id}`;
  }

  private saveRoute(): void {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.route));
    } catch {
      /* storage unavailable: the route just won't survive a refresh */
    }
  }

  private loadRoute(): Route {
    const fallback: Route = { start: this.yard.def.start, segments: [] };
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return fallback;
      const route = JSON.parse(raw) as Route;
      if (!route.start || !Array.isArray(route.segments)) return fallback;
      return route;
    } catch {
      return fallback;
    }
  }
}

function closestOnLine(p: Vec, a: Vec, b: Vec): Vec {
  // Infinite line, not just the segment, so stripes extend sideways from anywhere along the pass.
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 === 0) return a;
  const t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}

function dashedLine(
  g: Phaser.GameObjects.Graphics,
  a: Vec,
  b: Vec,
  color: number,
  alpha: number,
  width: number,
  dash: number,
  gap: number,
): void {
  const total = dist(a, b);
  if (total === 0) return;
  const d = { x: (b.x - a.x) / total, y: (b.y - a.y) / total };
  g.lineStyle(width, color, alpha);
  for (let s = 0; s < total; s += dash + gap) {
    const e = Math.min(total, s + dash);
    g.lineBetween(a.x + d.x * s, a.y + d.y * s, a.x + d.x * e, a.y + d.y * e);
  }
}

function dashedLoop(
  g: Phaser.GameObjects.Graphics,
  pts: Vec[],
  color: number,
  alpha: number,
  width: number,
  dash: number,
  gap: number,
): void {
  for (let i = 0; i < pts.length; i++) {
    dashedLine(g, pts[i], pts[(i + 1) % pts.length], color, alpha, width, dash, gap);
  }
}
