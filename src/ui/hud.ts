import { type EditorStore, type Overlay, PLAYBACK_RATES, TOOLS, formatTime } from '../state/editor';
import { PX_PER_FOOT } from '../sim/mower';
import type { JobResult } from '../sim/score';
import { type HitKind, type YardDef, TRIM_BAND } from '../sim/yard';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const HIT_LABELS: Record<HitKind, string> = {
  tree: 'tree',
  bed: 'mulch bed',
  flowers: 'flower bed',
  house: 'house',
  rock: 'rock',
  fence: 'fence',
  toy: 'toy',
  hose: 'hose',
  bounds: 'edge of map',
  neighbor: "neighbor's lawn",
};

function damageSummary(r: JobResult): string {
  if (r.damage.length === 0) return 'None';
  const counts = new Map<string, number>();
  for (const d of r.damage) {
    const label = HIT_LABELS[d.kind] ?? d.kind;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => `${k} ×${n}`).join(', ');
}

/** Binds the DOM toolbar/side panel/results modal to the editor store. */
export function mountHud(store: EditorStore, yards: YardDef[]): void {
  const select = $<HTMLSelectElement>('yard-select');
  for (const y of yards) {
    const opt = document.createElement('option');
    opt.value = y.id;
    opt.textContent = `${y.order}. ${y.name}`;
    select.appendChild(opt);
  }
  select.onchange = () => store.set({ yardId: select.value });

  const toolsEl = $('tools');
  const toolButtons = TOOLS.map((t) => {
    const b = document.createElement('button');
    b.innerHTML = `${t.label}<kbd>${t.key.toUpperCase()}</kbd>`;
    b.title = t.hint;
    b.onclick = () => store.set({ tool: t.id });
    toolsEl.appendChild(b);
    return b;
  });

  const speedsEl = $('speeds');
  const speedButtons = PLAYBACK_RATES.map((_, i) => {
    const b = document.createElement('button');
    b.textContent = `${2 ** i}x`;
    b.onclick = () => store.set({ playback: i });
    speedsEl.appendChild(b);
    return b;
  });

  $('undo').onclick = () => store.command('undo');
  $('redo').onclick = () => store.command('redo');
  $('clear').onclick = () => store.command('clear');
  $('mow').onclick = () => store.command('mow');
  $('stop').onclick = () => store.command('stop');
  $('res-edit').onclick = () => store.command('edit');
  $('res-again').onclick = () => store.command('mow');
  const snapEl = $<HTMLInputElement>('snap');
  snapEl.onchange = () => store.set({ snap: snapEl.checked });

  // "Look at lawn" hides the modal so the player can inspect the yard with overlays.
  let modalHidden = false;
  $('res-hide').onclick = () => {
    modalHidden = true;
    render();
  };
  $('show-results').onclick = () => {
    modalHidden = false;
    render();
  };
  const overlayButtons = [...$('overlays').querySelectorAll<HTMLButtonElement>('button')];
  for (const b of overlayButtons) {
    b.onclick = () => store.set({ overlay: b.dataset.overlay as Overlay });
  }

  let lastMode = store.state.mode;
  const render = () => {
    const s = store.state;
    if (s.mode !== lastMode) {
      modalHidden = false;
      lastMode = s.mode;
    }
    const editing = s.mode === 'edit';
    const yard = yards.find((y) => y.id === s.yardId)!;
    select.value = s.yardId;
    select.disabled = s.mode === 'mowing';
    $('yard-customer').textContent = yard.customer;
    $('yard-challenge').textContent = yard.challenge;
    $('yard-tip').textContent = yard.tip;
    $('mower-name').textContent = `Mower: ${s.mowerName}`;

    TOOLS.forEach((t, i) => {
      toolButtons[i].classList.toggle('active', t.id === s.tool);
      toolButtons[i].disabled = !editing;
    });
    $<HTMLButtonElement>('undo').disabled = !editing || !s.canUndo;
    $<HTMLButtonElement>('redo').disabled = !editing || !s.canRedo;
    $<HTMLButtonElement>('clear').disabled = !editing || s.segments === 0;
    $<HTMLButtonElement>('mow').disabled = s.mode === 'mowing' || s.segments === 0;
    snapEl.checked = s.snap;

    $('hint').textContent = editing
      ? TOOLS.find((t) => t.id === s.tool)!.hint
      : s.mode === 'mowing'
        ? 'Watch the mower follow your route.'
        : 'Check the missed spots and overlap heatmap, then tweak your route.';

    const e = s.estimate;
    $('est-time').textContent = e ? formatTime(e.time) : '–';
    $('est-coverage').textContent = e ? pct(e.coverage) : '–';
    $('est-turn').textContent = e ? formatTime(e.turnTime) : '–';
    $('est-overlap').textContent = e ? pct(e.overlap) : '–';
    $('est-distance').textContent = e ? `${Math.round(e.distance / PX_PER_FOOT)} ft` : '–';
    $('est-warn').textContent =
      e && e.damage.length ? `⚠ Route runs into: ${damageSummary(e)}` : '';

    $('playback').classList.toggle('hidden', s.mode !== 'mowing');
    speedButtons.forEach((b, i) => b.classList.toggle('active', i === s.playback));
    if (s.live) {
      $('live-time').textContent = formatTime(s.live.time);
      $('live-coverage').textContent = pct(s.live.coverage);
    }

    const r = s.result;
    const showResults = s.mode === 'results' && r;
    $('results').classList.toggle('hidden', !showResults || modalHidden);
    $('show-results').classList.toggle('hidden', !showResults || !modalHidden);
    if (r) {
      $('stars').textContent = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
      $('res-coverage').textContent = `${pct(r.coverage)} (${r.missedCells} cells missed)`;
      $('res-time').textContent = `${formatTime(r.time)} (${formatTime(r.turnTime)} turning)`;
      $('res-eff').textContent = pct(r.efficiency);
      $('res-overlap').textContent = pct(r.overlap);
      $('res-damage').textContent = damageSummary(r);
      // Rough length of fence line still to trim: trim-strip area / strip width.
      const trimFt = Math.round((r.edgeCells * yard.cellSize ** 2) / TRIM_BAND / PX_PER_FOOT);
      $('res-trim').textContent = `${trimFt} ft along fences (trimmer coming soon)`;
      document.querySelectorAll('.trim-row').forEach((el) => {
        el.classList.toggle('hidden', r.edgeCells === 0);
      });
      $('res-sat').textContent = `${Math.round(r.satisfaction)} / 100`;
    }
    overlayButtons.forEach((b) => b.classList.toggle('active', b.dataset.overlay === s.overlay));
  };
  store.subscribe(render);
}
