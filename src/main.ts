import Phaser from 'phaser';
import './style.css';
import { YARDS } from './data/yards';
import { MowScene } from './scenes/MowScene';
import { STARTER_MOWER } from './sim/mower';
import { EditorStore } from './state/editor';
import { mountHud } from './ui/hud';

const yard = YARDS.home;
const mower = STARTER_MOWER;

const store = new EditorStore({
  yardName: yard.name,
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

mountHud(store);

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: yard.width,
  height: yard.height,
  backgroundColor: '#1d2a1f',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  banner: false,
});
game.scene.add('mow', MowScene, true, { yard, mower, store });
