import type { YardDef } from '../../sim/yard';
import { type RawYard, loadYard } from './loader';

// Every JSON file in this folder is a yard; drop a new file in to add one.
const files = import.meta.glob<RawYard>('./*.json', { eager: true, import: 'default' });

export const YARD_LIST: YardDef[] = Object.values(files)
  .map(loadYard)
  .sort((a, b) => a.order - b.order);

export const YARDS: Record<string, YardDef> = Object.fromEntries(YARD_LIST.map((y) => [y.id, y]));
