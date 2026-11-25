import { describe, expect, it } from 'vitest';
import { STARTER_MOWER } from '../../sim/mower';
import { simulateJob } from '../../sim/score';
import { buildYard, hitTest, isValidStart } from '../../sim/yard';
import { YARD_LIST, YARDS } from '.';

describe('yard data files', () => {
  it('loads at least six yards with unique ids and orders', () => {
    expect(YARD_LIST.length).toBeGreaterThanOrEqual(6);
    expect(new Set(YARD_LIST.map((y) => y.id)).size).toBe(YARD_LIST.length);
    expect(new Set(YARD_LIST.map((y) => y.order)).size).toBe(YARD_LIST.length);
  });

  for (const def of YARD_LIST) {
    describe(def.id, () => {
      const yard = buildYard(def);

      it('is playable: has lawn, customer info and a valid default start', () => {
        expect(def.width).toBe(1120);
        expect(def.height).toBe(820);
        expect(def.customer && def.challenge && def.tip).toBeTruthy();
        expect(yard.grassCount).toBeGreaterThan(5000);
        expect(isValidStart(yard, def.start)).toBe(true);
        expect(hitTest(yard, def.start, STARTER_MOWER.deckWidth)).toBeNull();
      });
    });
  }
});

describe('yard challenges are present', () => {
  it('Patels: fences with one usable gate', () => {
    const yard = buildYard(YARDS.patel);
    expect(yard.edgeCount).toBeGreaterThan(0);
    const via = (x: number) =>
      simulateJob(yard, STARTER_MOWER, {
        start: { x, y: 340 },
        segments: [{ kind: 'line', to: { x, y: 260 } }],
      }).damage.map((d) => d.kind);
    expect(via(224)).not.toContain('fence'); // left gate fits
    expect(via(893)).toContain('fence'); // right gate is too narrow
  });

  it('Okafor: a slope', () => {
    expect(YARDS.okafor.zones.some((z) => z.kind === 'slope')).toBe(true);
  });

  it('Nguyens: toys and a hose', () => {
    const kinds = YARDS.nguyen.obstacles.map((o) => o.kind);
    expect(kinds).toContain('toy');
    expect(kinds).toContain('hose');
  });

  it('Lindqvist: lots of flower beds', () => {
    expect(YARDS.lindqvist.obstacles.filter((o) => o.kind === 'flowers').length).toBeGreaterThan(3);
  });

  it('Duffy: thick grass', () => {
    expect(YARDS.duffy.zones.some((z) => z.kind === 'thick')).toBe(true);
  });

  it('Corner lot: odd shape and two streets', () => {
    expect(YARDS.corner.property.length).toBeGreaterThan(4);
    expect(YARDS.corner.pavement.filter((p) => p.kind === 'asphalt').length).toBe(2);
  });
});
