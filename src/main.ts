import Phaser from 'phaser';
import './style.css';
import { YARDS, YARD_LIST } from './data/yards';
import { MowScene } from './scenes/MowScene';
import { STARTER_MOWER } from './sim/mower';
import { EditorStore } from './state/editor';
import { mountHud } from './ui/hud';

const YARD_KEY = 'lawnpro.yard';

function savedYardId(): string {
  try {
    const id = localStorage.getItem(YARD_KEY);
    if (id && YARDS[id]) return id;
  } catch {
    /* storage unavailable */
  }
  return YARD_LIST[0].id;
}

const mower = STARTER_MOWER;
const firstYard = YARDS[savedYardId()];

const store = new EditorStore({
  yardId: firstYard.id,
  mowerName: mower.name,
  tool: 'line',
  snap: true,
  mode: 'edit',
  overlay: 'normal',
  playback: 1,
  canUndo: false,
  canRedo: false,
  segments: 0,
  estimate: null,
  live: null,
  result: null,
});

mountHud(store, YARD_LIST);

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: firstYard.width,
  height: firstYard.height,
  backgroundColor: '#1d2a1f',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  banner: false,
});
game.scene.add('mow', MowScene, true, { yard: firstYard, mower, store });

// Switching jobs restarts the scene with the new yard.
let currentYard = firstYard.id;
store.subscribe((s) => {
  if (s.yardId === currentYard) return;
  currentYard = s.yardId;
  const yard = YARDS[s.yardId];
  try {
    localStorage.setItem(YARD_KEY, yard.id);
  } catch {
    /* storage unavailable */
  }
  if (game.scale.width !== yard.width || game.scale.height !== yard.height) {
    game.scale.setGameSize(yard.width, yard.height);
  }
  store.set({ mode: 'edit', overlay: 'normal', live: null, result: null, estimate: null });
  game.scene.getScene('mow')?.scene.restart({ yard, mower, store });
});
