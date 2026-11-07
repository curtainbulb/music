import { refreshPosters, ACTIONS } from './extras.js';
import { getNote, setNote } from './notes.js';
import { $, S, App, Sheet, Art, isOwned, setOwned, commitOwn, undo, toast, lsGet, lsSet, requestArt, onAlbumRemoved } from '../main.js';

const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? n.addEventListener(k.slice(2), v) : k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  n.append(...kids);
  return n;
};
const listEl = $('#list'), byId = () => new Map(S.albums.map((a) => [a.id, a]));
const allIds = () => [...listEl.querySelectorAll('.card')].map((c) => c.dataset.id);

document.head.append(h('style', {}, `
body[data-view=list] .section-body{grid-template-columns:1fr!important;gap:var(--space-2)}
body[data-view=list] .card{display:grid;grid-template-columns:64px 1fr;gap:var(--space-3);align-items:center}
.x-tools{display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;padding:var(--space-2) var(--space-4);max-width:var(--content-max);margin:0 auto}
.x-tools select,.x-tools input[type=range]{min-height:var(--touch);background:var(--bg2);color:inherit;border:1px solid var(--stroke);border-radius:var(--radius-1);padding:0 var(--space-2);font:inherit}
.card{transition:transform var(--dur-2) var(--ease-out)}.card:hover{transform:translateY(-3px)}.card:active{transform:scale(.97)}
.card.x-sel{outline:3px solid var(--accent,#6aa8ff);outline-offset:3px;border-radius:var(--radius-2)}
.x-bar{position:fixed;inset:auto 0 0 0;z-index:40;display:flex;gap:var(--space-2);align-items:center;justify-content:center;flex-wrap:wrap;padding:var(--space-3) var(--space-4) calc(var(--space-3) + env(safe-area-inset-bottom,0px));background:var(--surface);border-top:1px solid var(--stroke2);box-shadow:var(--elev-3)}
.x-table-wrap{overflow-x:auto;padding:0 var(--space-4) var(--space-8);max-width:var(--content-max);margin:0 auto}
.x-table{width:100%;border-collapse:collapse;font-size:var(--text-sm)}
.x-table th,.x-table td{text-align:left;padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--stroke)}
.x-table th button{all:inherit;cursor:pointer;min-height:var(--touch);font-weight:600}
.x-table tbody tr{cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 44px}.x-table tbody tr:hover{background:var(--surface2)}
.x-table td button{min-width:var(--touch);min-height:var(--touch);background:none;border:0;color:inherit;font-size:1.1rem;cursor:pointer}
.x-note{width:100%;box-sizing:border-box;margin:var(--space-3) 0;background:var(--bg2);color:inherit;border:1px solid var(--stroke);border-radius:var(--radius-1);padding:var(--space-2);font:inherit;resize:vertical}
.sheet{background-image:linear-gradient(180deg,color-mix(in srgb,var(--ambient,transparent) 30%,transparent),transparent 60%)}
.x-ai-note{font-size:var(--text-sm);color:var(--text2);border:1px solid var(--stroke);border-radius:var(--radius-1);padding:var(--space-2) var(--space-3);margin:0 0 var(--space-3)}
::view-transition-group(x-cover){animation-duration:var(--dur-3);animation-timing-function:var(--ease-out)}
`));

/* ---------- view modes, density, table ---------- */
let view = lsGet('crate.view', 'grid'), density = Number(lsGet('crate.density', '0')) || 0, sort = { key: 'artist', dir: 1 }, tableJob = 0;
const densityStyle = h('style');
document.head.append(densityStyle);
const viewSel = h('select', { 'aria-label': 'View', onchange: () => setView(viewSel.value) }, ...['grid', 'list', 'table'].map((v) => h('option', { value: v }, v[0].toUpperCase() + v.slice(1))));
const sizeRng = h('input', { type: 'range', min: '90', max: '240', value: String(density || 150), 'aria-label': 'Card size', oninput: () => { density = +sizeRng.value; lsSet('crate.density', String(density)); applyDensity(); } });
const tableWrap = h('div', { class: 'x-table-wrap', hidden: '' });
const tools = h('div', { class: 'x-tools' }, viewSel, sizeRng);
listEl.before(tools, tableWrap);
viewSel.value = view;

function applyDensity() { densityStyle.textContent = density && view === 'grid' ? `.section-body{grid-template-columns:repeat(auto-fill,minmax(${density}px,1fr))!important}` : ''; }
function setView(v) {
  view = v; lsSet('crate.view', v);
  document.body.dataset.view = v;
  listEl.hidden = v === 'table'; tableWrap.hidden = v !== 'table'; sizeRng.hidden = v !== 'grid';
  applyDensity();
  if (v === 'table') renderTable();
}

function renderTable() {
  if (view !== 'table') return;
  const job = ++tableJob, map = byId();
  const rows = allIds().map((id) => map.get(id)).filter(Boolean);
  const val = { artist: (a) => a.artist, title: (a) => a.title, year: (a) => a.year ?? 0, genre: (a) => a.section, owned: (a) => (isOwned(a) ? 1 : 0) }[sort.key];
  rows.sort((x, y) => (val(x) > val(y) ? 1 : val(x) < val(y) ? -1 : 0) * sort.dir);
  const head = h('tr', {}, ...['artist', 'title', 'year', 'genre', 'owned'].map((k) => h('th', { scope: 'col', 'aria-sort': sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
    h('button', { type: 'button', onclick: () => { sort = { key: k, dir: sort.key === k ? -sort.dir : 1 }; renderTable(); } }, k[0].toUpperCase() + k.slice(1)))));
  const body = h('tbody');
  tableWrap.replaceChildren(h('table', { class: 'x-table' }, h('thead', {}, head), body));
  let i = 0;
  const chunk = () => {
    if (job !== tableJob) return;
    for (const a of rows.slice(i, i + 300)) {
      const own = h('button', { type: 'button', 'aria-label': `Toggle owned: ${a.title}`, 'aria-pressed': String(!!isOwned(a)), onclick: (e) => { e.stopPropagation(); setOwned(a, !isOwned(a), { silent: true }); renderTable(); } }, isOwned(a) ? '●' : '○');
      const tr = h('tr', { onclick: () => Sheet.open(a) }, h('td', {}, a.artist), h('td', {}, a.title), h('td', {}, a.year ? String(a.year) : ''), h('td', {}, a.section), h('td', {}, own));
      body.append(tr);
    }
    i += 300;
    if (i < rows.length) setTimeout(chunk, 0);
  };
  chunk();
}
for (const name of ['renderList', 'applyText']) {
  const original = App[name];
  App[name] = (...args) => { const r = original(...args); queueMicrotask(renderTable); return r; };
}
ACTIONS.push(...['grid', 'list', 'table'].map((v) => ({ label: `${v[0].toUpperCase() + v.slice(1)} view`, run: () => { viewSel.value = v; setView(v); } })));
setView(view);

/* ---------- multi-select with bulk actions ---------- */
let selecting = false, lastId = null, pressTimer = 0, swallow = false;
const sel = new Set();
const count = h('span', { role: 'status', 'aria-live': 'polite' });
const bulk = (label, fn) => h('button', { class: 'btn', type: 'button', onclick: fn }, label);
const bar = h('div', { class: 'x-bar', hidden: '', role: 'toolbar', 'aria-label': 'Selection actions' }, count,
  bulk('Own', () => bulkOwn(true)), bulk('Unown', () => bulkOwn(false)), bulk('Retry covers', bulkRetry), bulk('Done', () => setSelecting(false)));
document.body.append(bar);
onAlbumRemoved((id) => { sel.delete(id); if (lastId === id) lastId = null; paintSel(); });

function paintSel() {
  bar.hidden = !selecting; count.textContent = `${sel.size} selected`;
  listEl.querySelectorAll('.card').forEach((c) => c.classList.toggle('x-sel', sel.has(c.dataset.id)));
}
function setSelecting(on) { selecting = on; if (!on) { sel.clear(); lastId = null; } paintSel(); }
function toggleSel(id, range) {
  if (range && lastId) {
    const ids = allIds(), i = ids.indexOf(lastId), j = ids.indexOf(id);
    if (i >= 0 && j >= 0) ids.slice(Math.min(i, j), Math.max(i, j) + 1).forEach((x) => sel.add(x));
  } else sel.has(id) ? sel.delete(id) : sel.add(id);
  lastId = id; paintSel();
}
listEl.addEventListener('click', (e) => {
  if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); return; }
  const card = selecting && e.target.closest('.card');
  if (!card) return;
  e.preventDefault(); e.stopPropagation();
  toggleSel(card.dataset.id, e.shiftKey);
}, true);
listEl.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.button) return;
  pressTimer = setTimeout(() => { swallow = true; selecting = true; toggleSel(card.dataset.id); }, 500);
});
for (const type of ['pointerup', 'pointermove', 'pointercancel']) listEl.addEventListener(type, () => clearTimeout(pressTimer));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && selecting && !document.querySelector('dialog[open]')) setSelecting(false); });

function bulkOwn(val) {
  const map = byId(), items = [...sel].map((id) => map.get(id)).filter(Boolean);
  if (!items.length) return;
  commitOwn(items.map((a) => [a, val]));
  toast(`${val ? 'Added' : 'Removed'} ${items.length}`, { label: 'Undo', fn: undo });
  if (S.own !== 'all') App.renderList();
}
async function bulkRetry() {
  const ids = [...sel];
  if (!ids.length) return;
  const prev = await Promise.all(ids.map((id) => Art.peek(id)));
  await Promise.all(ids.map((id) => Art.retry(id)));
  ids.forEach(refreshPosters);
  toast(`Retrying ${ids.length} covers`, { label: 'Undo', fn: async () => { await Promise.all(ids.map((id) => Art.retry(id))); Art.restoreEntries(prev.filter(Boolean)); ids.forEach(refreshPosters); } });
}
const selBtn = h('button', { class: 'icon-btn', title: 'Select multiple', 'aria-label': 'Select multiple albums', onclick: () => setSelecting(!selecting) }, '☑');
$('#importBtn')?.before(selBtn) ?? $('#helpBtn').before(selBtn);
ACTIONS.push({ label: 'Select multiple', run: () => setSelecting(true) });

/* ---------- notes, ambient colour, shared-element open ---------- */
// Reads/writes go straight through js/ui/notes.js (the single notes store) instead of a module-load-time
// snapshot, so a note added by CSV/JSON/cloud import (mergeImportedNotes, called from extras.js) shows up
// the next time a sheet opens without needing a reload.
const noteBox = h('textarea', { class: 'x-note', rows: '2', placeholder: 'Notes', 'aria-label': 'Album notes' });
$('#sheetTags').after(noteBox);
let noteId = null, noteTimer = 0;
noteBox.addEventListener('input', () => {
  const id = noteId; clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { if (!id) return; setNote(id, noteBox.value); }, 400);
});

function ambient() {
  const host = $('#sheetPoster'), src = host.querySelector('img.art.in') ?? host.querySelector('canvas');
  if (!src) return;
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true });
  const read = (s) => {
    g.drawImage(s, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data, n = d.length / 4;
    let r = 0, gr = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
    return `rgb(${(r / n) | 0},${(gr / n) | 0},${(b / n) | 0})`;
  };
  let color = null;
  try { color = read(src); } catch { try { color = read(host.querySelector('canvas')); } catch { /* keep default */ } }
  if (color) $('#sheet').style.setProperty('--ambient', color);
}
{
  const open0 = Sheet.open;
  Sheet.open = (a, why) => {
    noteId = a.id; noteBox.value = getNote(a.id);
    const run = () => { open0(a, why); [0, 400, 1200].forEach((t) => setTimeout(ambient, t)); };
    const src = listEl.querySelector(`.card[data-id="${CSS.escape(a.id)}"] .poster`), poster = $('#sheetPoster');
    if (src && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      src.style.viewTransitionName = 'x-cover';
      document.startViewTransition(() => { src.style.viewTransitionName = ''; poster.style.viewTransitionName = 'x-cover'; run(); }).finished.finally(() => { poster.style.viewTransitionName = ''; });
    } else run();
  };
}

/* ---------- AI notice + idle cover sweep ---------- */
$('#aiBtn')?.addEventListener('click', () => setTimeout(() => {
  const dlg = document.querySelector('dialog[open]') ?? [...document.querySelectorAll('[role=dialog]')].find((d) => d.offsetParent && /key|provider/i.test(d.textContent));
  if (!dlg || dlg.querySelector('.x-ai-note')) return;
  dlg.prepend(h('p', { class: 'x-ai-note' }, 'Nothing is sent until you press the button. A request sends a sample of up to 40 albums from your crate to the one provider you pick. Keys stay in this browser and go only to that provider.'));
}, 0));
const idleSweep = () => listEl.querySelectorAll('.poster').forEach((p) => { if (p._painted && !p._art && !p._cb) requestArt(p, 3); });
setInterval(() => (globalThis.requestIdleCallback ?? setTimeout)(idleSweep), 8000);
