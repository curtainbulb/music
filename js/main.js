'use strict';
/**
 * App entry point (v4). This used to be an inline classic <script> in index.html, where top-level
 * `function` declarations doubled as reassignable `window.*` properties — that's what let js/ui/extras.js
 * and js/ui/views.js "monkey-patch" openSheet/renderList/applyText by reading and writing globals by
 * name (see docs/DEVLOG.md Slice 3). ES modules don't have that trick: an imported binding is read-only from
 * the importer's side. So the handful of functions other modules need to extend are exposed as
 * properties of two small, explicitly-exported, mutable objects — `App` and `Sheet` — instead of bare
 * globals. Internal code in this file calls through those objects too (e.g. `App.renderList()`, not a
 * bare `renderList()`), so a wrapper installed by another module is actually used everywhere, exactly
 * like the old global-reassignment trick, but as a declared, typed extension point instead of an
 * implicit one. Everything else other modules need (S, Art, isOwned, toast, requestArt, ...) is a plain
 * named export — nobody needs to replace those, so a normal read-only import binding is enough.
 */
import { importText } from './parser/formats.js';
import { norm, UNSORTED, cleanHeading } from './parser/text.js';
import { createCovers, resizeCover } from './covers/boot.js';
import { createLimiter } from './covers/limiter.js';
import { keyOf, saveKey, keyRemembered } from './store/keys.js';
import { lsGet, lsSet } from './store/local.js';
import { shouldSkipDefaultLoad } from './store/source-gate.js';
import { diffAlbums, summarize as summarizeDiff } from './ui/patch.js';
import * as patchMod from './ui/patch.js';
import { PROVIDERS, chat, listModels, aiChain, askModel, detectKeyProvider, generateSynopsis, synopsisStub } from './ai/smartpicks.js';
import { resolveFreeform } from './parser/freeform.js';

export { lsGet, lsSet, norm, UNSORTED, keyOf, saveKey };

/* =====================================================================
   STATE + PERSISTENCE (all storage access is guarded)
   ===================================================================== */
export const $ = (s) => document.querySelector(s);
export const S = { albums: [], byId: new Map(), sections: [], decades: [], hasUnknownYear: false, skipped: [], source: '', sourceKind: '',
  query: '', section: 'all', decade: 'all', own: 'all', sort: lsGet('crate.sort', 'taxonomy'), collapsed: new Set(), ownMap: {}, lastText: '' };
try { S.ownMap = JSON.parse(lsGet('crate.own.v2', '{}')) || {}; } catch { S.ownMap = {}; }
try { S.collapsed = new Set(JSON.parse(lsGet('crate.collapsed', '[]'))); } catch { S.collapsed = new Set(); }
export const isOwned = (a) => ((a.id in S.ownMap) ? S.ownMap[a.id] === 1 : a.mdOwned);
export const titleCase = (s) => (s || '').toLowerCase().replace(/(^|[\s/(-])([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
export const decadeOf = (a) => (a.year ? Math.floor(a.year / 10) * 10 : 'unk');

/* =====================================================================
   COVER ART — provider pipeline lives in js/covers/*; this just adapts its
   want/unwant/markBad/retryMissing contract and wires status to the footer.
   ===================================================================== */
let artFound = 0, artLast = null;
const artStatus = { onChange: null };
const emitArt = (st) => artStatus.onChange && artStatus.onChange({ found: artFound, queued: st ? st.queued : 0, paused: false, offline: !navigator.onLine });
const coverSvc = createCovers((st) => { artLast = st; artFound = Object.values(st.stats).reduce((n, x) => n + x.hits, 0); emitArt(st); }, (name) => keyOf(name));
const artPriority = (h) => (h === true ? 0 : h || 1);
export const Art = {
  status: artStatus,
  resize: (u, px) => resizeCover(u, px),
  want(album, cb, hot) { coverSvc.want(album, cb, artPriority(hot)); },
  unwant(id, cb) { coverSvc.unwant(id, cb); },
  markBad(id) { coverSvc.markBad(id); },
  retryMissing: () => coverSvc.clearMisses(),
  snapshot: () => artLast,
  peek: (id) => coverSvc.peek(id),
  retry: (id) => coverSvc.retry(id),
  setUser: (id, p) => coverSvc.setUser(id, p),
  restoreEntries: (es) => coverSvc.restore(es),
  found: () => artFound,
  nearMisses: (id) => coverSvc.nearMisses(id),
};

/* =====================================================================
   POSTERS — generated placeholder (always painted, never blank) with the
   real cover faded in on top when found.
   ===================================================================== */
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const GENRE_HUE = [
  { k: /PUNK|HARDCORE/, hue: 350, m: 'spike' }, { k: /METAL|SLUDGE|DOOM|STONER|GRUNGE/, hue: 265, m: 'shard' },
  { k: /PSYCHEDELIC|SPACE|AMBIENT|KRAUT/, hue: 285, m: 'orbit' }, { k: /FOLK|COUNTRY|AMERICANA|ROOTS/, hue: 35, m: 'stripe' },
  { k: /FUNK|SOUL|BLUES|JAZZ/, hue: 28, m: 'arc' }, { k: /SYNTH|DANCE|ELECTRO|INDUSTRIAL/, hue: 200, m: 'grid' },
  { k: /RAP/, hue: 14, m: 'block' }, { k: /POP|NEW WAVE|BRIT/, hue: 330, m: 'dot' },
  { k: /INDIE|EMO|POST|SHOEGAZE|NOISE|MATH/, hue: 150, m: 'wave' }, { k: /PROG/, hue: 255, m: 'orbit' }, { k: /./, hue: 215, m: 'stripe' },
];
/**
 * Placeholder tile shown until a real cover loads (or in its place, if none is ever found). Deliberately
 * quiet: a flat, muted, per-genre tint plus the artist/title text, with no decorative pattern. An earlier
 * version drew loud diagonal gradients and per-genre shapes (spikes, orbits, grids...) at near-full
 * saturation/opacity — striking in isolation, but wrong for something shown on every one of a few hundred
 * cards, most of which never get replaced by real art because this sandbox cannot reach any cover
 * provider (see docs/DEVLOG.md). A loading/fallback state that loud reads as "the real design", not as
 * a placeholder, which is the complaint this redraw answers. Genre still maps to a hue (so the grid keeps
 * some at-a-glance color variety) but at low saturation/opacity so it recedes rather than competes with
 * the title text or, once one arrives, the real cover art fading in on top of it.
 */
function drawPoster(canvas, a, S_) {
  const fam = GENRE_HUE.find((g) => g.k.test(a.section || ''));
  const hue = (fam.hue + (a.year ? ((a.year - 1960) % 60) / 60 * 20 - 10 : 0) + 360) % 360, k = S_ / 240;
  canvas.width = canvas.height = S_; const ctx = canvas.getContext('2d'); ctx.scale(k, k); const W = 240;
  ctx.fillStyle = `hsl(${hue} 22% 16%)`; ctx.fillRect(0, 0, W, W);
  ctx.fillStyle = `hsl(${hue} 30% 22%)`; ctx.beginPath(); ctx.arc(W * .74, W * .22, W * .52, 0, 6.283); ctx.fill();
  const vg = ctx.createLinearGradient(0, W * .5, 0, W); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.62)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, W);
  const wrap = (text, max, maxLines) => {
    const ws = text.split(/\s+/), out = []; let cur = '';
    for (const w of ws) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > max && cur) { out.push(cur); cur = w; } else cur = t; }
    out.push(cur); if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/.{0,2}$/, '…'); } return out;
  };
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 4;
  ctx.font = '800 19px -apple-system, "Segoe UI", sans-serif'; const tl = wrap(a.title, 208, 3);
  ctx.font = '600 12px -apple-system, "Segoe UI", sans-serif'; ctx.globalAlpha = .8; ctx.fillText(a.artist.length > 30 ? a.artist.slice(0, 29) + '…' : a.artist, 14, 226);
  ctx.globalAlpha = 1; ctx.font = '800 19px -apple-system, "Segoe UI", sans-serif'; let y = 208 - (tl.length - 1) * 22; tl.forEach((l) => { ctx.fillText(l, 14, y); y += 22; });
}
function showArt(el, url) {
  if (!url) { el._art = 'none'; return; }
  const img = new Image(); img.className = 'art'; img.alt = ''; img.width = 200; img.height = 200; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
  img.onload = () => { img.classList.add('in'); el._art = 'ok'; };
  img.onerror = () => { img.remove(); el._art = 'none'; Art.markBad(el._album.id); };
  img.src = url; el.insertBefore(img, el.querySelector('canvas').nextSibling);
}
export function requestArt(el, priority) {
  const p = priority === true ? 0 : priority || 1;
  if (el._art) return;
  if (el._cb) { if (p < (el._prio ?? 9)) { el._prio = p; Art.want(el._album, el._cb, priority); } return; }
  el._prio = p;
  el._cb = (url) => { el._cb = null; showArt(el, url && priority === true ? Art.resize(url, 600) : url); };
  Art.want(el._album, el._cb, priority);
}
export function releaseArt(el) { if (el._cb) { Art.unwant(el._album.id, el._cb); el._cb = null; } }
// "On-screen" (priority 1, 250px), "near-screen, ~2 screens out" (priority 2) and idle sweep (priority 3,
// scheduled from js/ui/views.js) are the three background tiers; priority 0 ("jump") is the eager,
// full-size fetch used when a detail sheet opens. All four of the queue's tiers (see PRIORITY in
// js/covers/service.js) are fed from here and from views.js's idle sweep.
const posterObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target;
    if (e.isIntersecting) { if (!el._painted) { drawPoster(el.firstChild, el._album, 240); el._painted = true; } requestArt(el); }
    else if ((el._prio ?? 1) <= 1) releaseArt(el);
  }
}, { rootMargin: '250px' });
const farObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const el = e.target;
    if (e.isIntersecting) { if (!el._painted) { drawPoster(el.firstChild, el._album, 240); el._painted = true; } requestArt(el, 2); }
    else if ((el._prio ?? 9) >= 2) releaseArt(el);
  }
}, { rootMargin: `${Math.max(1200, Math.round((window.innerHeight || 900) * 2))}px` });
export function makePoster(album, { eager = false } = {}) {
  const el = document.createElement('div'); el.className = 'poster'; el._album = album;
  el.appendChild(document.createElement('canvas'));
  if (eager) { drawPoster(el.firstChild, album, 480); el._painted = true; requestArt(el, true); } else { posterObserver.observe(el); farObserver.observe(el); }
  return el;
}

/* =====================================================================
   RECOMMENDATIONS (content-based: genre affinity + same-artist + era)
   ===================================================================== */
export function recommend(n = 14) {
  const owned = S.albums.filter(isOwned);
  if (!owned.length) {
    const seen = new Set();
    return S.albums.filter((a) => { if (a.section === UNSORTED || seen.has(a.section)) return false; seen.add(a.section); return true; }).slice(0, n).map((a) => ({ a, why: 'Start your ' + titleCase(a.section.split('/')[0].trim()) + ' crate' }));
  }
  const sec = {}, art = {}; let max = 1, ys = 0, yn = 0;
  for (const a of owned) { sec[a.section] = (sec[a.section] || 0) + 1; max = Math.max(max, sec[a.section]); art[a.artist] = 1; if (a.year) { ys += a.year; yn++; } }
  const cy = yn ? ys / yn : 1975;
  return S.albums.filter((a) => !isOwned(a)).map((a) => {
    const s = (sec[a.section] || 0) / max, ar = art[a.artist] ? 1 : 0, d = a.year ? Math.abs(a.year - cy) : 20, e = Math.exp(-(d * d) / 392);
    let why = 'Matches your ' + titleCase(a.section.split('/')[0].trim()) + ' taste';
    if (ar) why = 'More ' + a.artist; else if (e > .6 && s < .3) why = 'Fits your ' + Math.round(cy / 10) * 10 + 's sweet spot';
    return { a, why, score: s * .45 + ar * .4 + e * .15 + mulberry32(hashStr(a.id))() * .03 };
  }).sort((x, y) => y.score - x.score).slice(0, n);
}
const serviceLinks = (a) => { const q = encodeURIComponent(`${a.artist} ${a.title}`); return [
  { name: 'Spotify', glyph: '♫', url: `https://open.spotify.com/search/${q}` },
  { name: 'Apple Music', glyph: '♪', url: `https://music.apple.com/search?term=${q}` },
  { name: 'YouTube Music', glyph: '▶', url: `https://music.youtube.com/search?q=${q}` }]; };

/* =====================================================================
   RENDER — cards are built once per album and re-parented; toggling
   ownership mutates classes in place (no re-render, no flicker).
   ===================================================================== */
const cards = new Map(); // id -> {el, badge}
const listEl = $('#list'), recWrap = $('#recWrap');
let statsRefs = null, recTimer = null;

function buildCard(a) {
  const card = document.createElement('div'); card.className = 'card'; card.dataset.id = a.id;
  card.setAttribute('role', 'button'); card.tabIndex = 0;
  card.setAttribute('aria-label', `${a.title} by ${a.artist}${a.year ? ', ' + a.year : ''}`);
  const poster = makePoster(a);
  const badge = document.createElement('button'); badge.className = 'own-badge'; badge.type = 'button'; badge.textContent = '✓';
  badge.addEventListener('click', (e) => { e.stopPropagation(); toggleOwnedWithPulse(badge, a); });
  badge.addEventListener('keydown', (e) => e.stopPropagation());
  poster.appendChild(badge);
  const meta = document.createElement('div'); meta.className = 'card-meta';
  for (const [c, t] of [['card-title', a.title], ['card-artist', a.artist], ['card-year', a.year || '—']]) { const d = document.createElement('div'); d.className = c; d.textContent = t; meta.appendChild(d); }
  card.append(poster, meta);
  card.addEventListener('click', () => Sheet.open(a));
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Sheet.open(a); } });
  return { el: card, badge };
}
function buildCards() {
  posterObserver.disconnect(); farObserver.disconnect(); cards.clear();
  for (const a of S.albums) { cards.set(a.id, buildCard(a)); paintOwned(a); }
}
export function paintOwned(a) {
  const c = cards.get(a.id); if (!c) return; const o = isOwned(a);
  c.el.classList.toggle('owned', o); c.badge.setAttribute('aria-pressed', String(o));
  const label = o ? `In your crate — remove ${a.title}` : `Add ${a.title} to your crate`;
  c.badge.setAttribute('aria-label', label); c.badge.title = label;
}
/**
 * Button clarity (brief item 2): distinct default/active state (handled by paintOwned's class+label
 * above and the CSS `.card.owned .own-badge` rule), a 120ms scale-pulse on the actual toggle (not on every
 * re-render — the `.pulse` class is added here and removed after the animation, see the CSS comment), and
 * a disabled/mid-flight `aria-disabled` + explanatory title while the change is being committed. The
 * commit itself (`setOwned`/`commitOwn`) is synchronous local state today, so the disabled window is a
 * single frame; the hook exists so a future async save (e.g. writing back to a synced source) gets the
 * same mid-flight affordance for free instead of needing this wired in again later.
 */
function toggleOwnedWithPulse(btn, a, opts) {
  if (btn.getAttribute('aria-disabled') === 'true') return;
  btn.setAttribute('aria-disabled', 'true'); const prevTitle = btn.title; btn.title = 'Saving…';
  try { setOwned(a, !isOwned(a), opts); }
  finally {
    btn.removeAttribute('aria-disabled'); btn.title = prevTitle;
    btn.classList.remove('pulse'); void btn.offsetWidth; btn.classList.add('pulse');
    btn.addEventListener('animationend', () => btn.classList.remove('pulse'), { once: true });
  }
}
export function setOwned(a, val, { silent = false } = {}) {
  commitOwn([[a, val]]);
  if (S.own !== 'all' && !silent) App.renderList();
  toast(val ? 'Added to crate' : 'Removed from crate', { label: 'Undo', fn: undo });
}
/** Counts up instead of jumping, like the rest of the motion system; a no-op under reduced motion. */
function animateCount(el, to, render) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  if (to === from || matchMedia('(prefers-reduced-motion: reduce)').matches) { render(to); return; }
  const t0 = performance.now(), ms = 500;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / ms), eased = 1 - (1 - p) ** 3;
    render(Math.round(from + (to - from) * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
export function renderStats() {
  const el = $('#stats');
  if (!statsRefs) {
    const SVGNS = 'http://www.w3.org/2000/svg';
    const ringWrap = document.createElement('div'); ringWrap.className = 'ring-wrap';
    const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 84 84'); svg.setAttribute('aria-hidden', 'true');
    const bg = document.createElementNS(SVGNS, 'circle'); bg.setAttribute('class', 'ring-bg'); bg.setAttribute('cx', '42'); bg.setAttribute('cy', '42'); bg.setAttribute('r', '34');
    const fg = document.createElementNS(SVGNS, 'circle'); fg.setAttribute('class', 'ring-fg'); fg.setAttribute('cx', '42'); fg.setAttribute('cy', '42'); fg.setAttribute('r', '34');
    svg.append(bg, fg);
    const ringLabel = document.createElement('div'); ringLabel.className = 'ring-label';
    ringWrap.append(svg, ringLabel);
    const meta = document.createElement('div'); meta.className = 'stats-meta';
    meta.append(document.createElement('b'), document.createElement('span'), Object.assign(document.createElement('div'), { className: 'decade-bars' }));
    el.replaceChildren(ringWrap, meta);
    statsRefs = { fg: el.querySelector('.ring-fg'), lab: el.querySelector('.ring-label'), b: el.querySelector('b'), span: el.querySelector('span'), bars: el.querySelector('.decade-bars'), key: '' };
    statsRefs.fg.setAttribute('stroke-dasharray', 2 * Math.PI * 34);
  }
  const total = S.albums.length; let own = 0; const dOwn = new Map(), dTot = new Map();
  for (const a of S.albums) { const d = decadeOf(a), o = isOwned(a); if (o) own++; dTot.set(d, (dTot.get(d) || 0) + 1); if (o) dOwn.set(d, (dOwn.get(d) || 0) + 1); }
  const pct = total ? own / total : 0, C = 2 * Math.PI * 34;
  statsRefs.fg.setAttribute('stroke-dashoffset', C * (1 - pct));
  animateCount(statsRefs.lab, Math.round(pct * 100), (v) => { statsRefs.lab.textContent = v + '%'; });
  animateCount(statsRefs.b, own, (v) => { statsRefs.b.textContent = `${v} / ${total} owned`; });
  const real = S.decades; statsRefs.span.textContent = `${S.sections.length} genres` + (real.length ? ` · ${real[0]}s–${real[real.length - 1]}s` : '');
  const key = real.join(','); if (statsRefs.key !== key) { statsRefs.key = key; statsRefs.bars.replaceChildren(...real.map((d) => { const b = document.createElement('div'); b.className = 'decade-bar'; b.title = d + 's'; b.appendChild(document.createElement('i')); return b; })); }
  [...statsRefs.bars.children].forEach((b, i) => { const d = real[i]; b.firstChild.style.height = ((dOwn.get(d) || 0) / (dTot.get(d) || 1)) * 100 + '%'; });
}
function renderRecs() {
  const recs = S.albums.length ? recommend(14) : [];
  if (!recs.length) { recWrap.replaceChildren(); return; }
  const old = recWrap.querySelector('.rail'), sl = old ? old.scrollLeft : 0;
  recWrap.querySelectorAll('.poster').forEach(releaseArt);
  const head = document.createElement('div'); head.className = 'rail-head';
  const h2 = document.createElement('h2'); h2.textContent = 'For You';
  const sub = document.createElement('span'); sub.textContent = 'Genre · artist · era match';
  head.append(h2, sub);
  const rail = document.createElement('div'); rail.className = 'rail';
  for (const { a, why } of recs) {
    const c = document.createElement('div'); c.className = 'rec-card'; c.setAttribute('role', 'button'); c.tabIndex = 0;
    const p = makePoster(a); const w = document.createElement('div'); w.className = 'rec-why'; w.textContent = why; p.appendChild(w);
    const t = document.createElement('div'); t.className = 'card-title'; t.textContent = a.title; t.style.marginTop = '8px';
    const r = document.createElement('div'); r.className = 'card-artist'; r.textContent = a.artist + ' · ' + (a.year || '—');
    c.append(p, t, r); c.addEventListener('click', () => Sheet.open(a, why));
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Sheet.open(a, why); } });
    rail.appendChild(c);
  }
  recWrap.replaceChildren(head, rail); rail.scrollLeft = sl;
}
function filtered() {
  const q = norm(S.query);
  const out = S.albums.filter((a) => {
    if (S.section !== 'all' && a.section !== S.section) return false;
    if (S.decade !== 'all' && decadeOf(a) !== S.decade) return false;
    if (S.own !== 'all' && (S.own === 'owned') !== isOwned(a)) return false;
    return !q || a.hay.includes(q);
  });
  const cmp = { az: (a, b) => norm(a.artist).localeCompare(norm(b.artist)) || (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title),
    year: (a, b) => (a.year || 9999) - (b.year || 9999) || norm(a.artist).localeCompare(norm(b.artist)) }[S.sort];
  return cmp ? out.sort(cmp) : out;
}
function renderList() {
  const data = filtered(), frag = document.createDocumentFragment(); syncClear();
  listEl.classList.remove('enter'); void listEl.offsetWidth; listEl.classList.add('enter');
  $('#subcount').textContent = S.albums.length ? `${data.length} of ${S.albums.length} albums` : 'No albums loaded';
  if (!data.length) {
    const d = document.createElement('div'); d.className = 'state';
    const crateEmpty = S.own === 'owned' && !S.albums.some(isOwned);
    const stateB = document.createElement('b'); stateB.textContent = crateEmpty ? 'Your crate is empty' : 'No matches';
    d.append(stateB, crateEmpty ? 'Tap the circle on any album to add it.' : 'Nothing fits the current search and filters.');
    if (activeFilters()) { const b = document.createElement('button'); b.className = 'btn primary'; b.type = 'button'; b.textContent = 'Clear filters'; b.addEventListener('click', clearFilters); d.append(document.createElement('br'), b); }
    return listEl.replaceChildren(d);
  }
  const groups = [];
  if (S.sort !== 'taxonomy') groups.push({ label: null, items: data });
  else { const by = new Map(); for (const a of data) { if (!by.has(a.section)) by.set(a.section, []); by.get(a.section).push(a); }
    for (const s of S.sections) if (by.has(s)) groups.push({ label: s, items: by.get(s) }); }
  for (const { label, items } of groups) {
    const collapsed = label && S.collapsed.has(label) && S.query === '';
    if (label) {
      const h = document.createElement('div'); h.className = 'section-head' + (collapsed ? ' collapsed' : '');
      h.setAttribute('role', 'button'); h.tabIndex = 0; h.setAttribute('aria-expanded', String(!collapsed));
      const t = document.createElement('h3'); t.textContent = titleCase(label); t.title = titleCase(label);
      const c = document.createElement('span'); c.className = 'section-count'; c.textContent = items.length;
      const v = document.createElement('span'); v.className = 'chevron'; v.textContent = '▾';
      const own = items.some((a) => !isOwned(a)), bulk = document.createElement('button');
      bulk.type = 'button'; bulk.className = 'sec-act'; bulk.textContent = own ? 'Own all' : 'Clear all';
      bulk.title = `${own ? 'Mark' : 'Unmark'} ${items.length} album${items.length > 1 ? 's' : ''} as owned`;
      bulk.addEventListener('keydown', (e) => e.stopPropagation());
      bulk.addEventListener('click', (e) => { e.stopPropagation(); const ch = items.filter((a) => isOwned(a) !== own).map((a) => [a, own]); commitOwn(ch);
        toast(`${own ? 'Added' : 'Removed'} ${ch.length} in ${titleCase(label)}`, { label: 'Undo', fn: undo }); App.renderList(); });
      h.append(t, c, bulk, v);
      const toggle = () => { S.collapsed.has(label) ? S.collapsed.delete(label) : S.collapsed.add(label); lsSet('crate.collapsed', JSON.stringify([...S.collapsed])); App.renderList(); };
      h.addEventListener('click', toggle); h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      frag.appendChild(h);
    }
    const body = document.createElement('div'); body.className = 'section-body' + (collapsed ? ' collapsed' : '');
    for (const a of items) body.appendChild(cards.get(a.id).el);
    frag.appendChild(body);
  }
  listEl.replaceChildren(frag);
}
function renderFilters() {
  const g = $('#genreSel'); g.replaceChildren();
  const counts = new Map(); for (const a of S.albums) counts.set(a.section, (counts.get(a.section) || 0) + 1);
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; g.appendChild(o); };
  add('all', `All genres (${S.sections.length})`); for (const s of S.sections) add(s, `${titleCase(s)} (${counts.get(s)})`);
  g.value = S.section; if (g.value !== S.section) { S.section = 'all'; g.value = 'all'; }
  renderGenreList(counts);
  const row = $('#chipDecade'); row.replaceChildren();
  const mk = (label, val) => { const b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.dataset.val = String(val); b.textContent = label;
    b.addEventListener('click', () => { S.decade = (S.decade === val && val !== 'all') ? 'all' : val; syncChips(); App.renderList(); }); row.appendChild(b); };
  mk('All eras', 'all'); S.decades.forEach((d) => mk(d + 's', d)); if (S.hasUnknownYear) mk('Unknown', 'unk');
  if (S.decade !== 'all' && ![...row.children].some((b) => b.dataset.val === String(S.decade))) S.decade = 'all';
  syncChips();
}
/** Desktop sidebar's genre list (spec 4: "desktop persistent sidebar (genres w/ counts...)"). Mirrors
 * #genreSel one-for-one; the <select> remains the control inside the mobile filters sheet. */
function renderGenreList(counts) {
  const nav = $('#genreList'); if (!nav) return;
  const mk = (val, label, count) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'genre-item' + (S.section === val ? ' active' : '');
    b.setAttribute('aria-pressed', String(S.section === val));
    const n = document.createElement('span'); n.className = 'genre-item-name'; n.textContent = label;
    b.append(n);
    if (count != null) { const c = document.createElement('span'); c.className = 'genre-item-count'; c.textContent = count; b.append(c); }
    b.addEventListener('click', () => { S.section = val; $('#genreSel').value = val; App.renderList(); renderFilters(); closeFilterSheet(); });
    return b;
  };
  nav.replaceChildren(mk('all', 'All genres', S.albums.length), ...S.sections.map((s) => mk(s, titleCase(s), counts.get(s))));
}
function syncChips() { $('#chipDecade').querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.val === String(S.decade))); }

/* =====================================================================
   DETAIL SHEET — exported through `Sheet` (not plain functions) so other
   modules can wrap open/close; see the module docblock above.
   ===================================================================== */
let sheetAlbum = null, lastFocus = null;
function fillSheetOwn() {
  const o = isOwned(sheetAlbum), b = $('#sheetOwnBtn');
  b.textContent = o ? '✓ In your crate' : '+ Add to crate';
  b.className = 'btn primary' + (o ? ' is-owned' : '');
  b.setAttribute('aria-pressed', String(o));
  b.title = o ? 'Remove this album from your crate' : 'Add this album to your crate';
}
/**
 * Auto-surfacing the poster-choice modal (brief item 3c) on a lookup miss. Popping a blocking <dialog>
 * for every missed cover while scrolling a grid of hundreds of albums was correctly rejected in Slice 10
 * as hostile UX — that stands. What's new here is scoped to a single, deliberate point of attention: the
 * ONE album the user has opened the detail sheet for. The eager, full-size lookup `makePoster(a, {eager})`
 * already kicks off here (priority 'jump') independent of this hook; this just listens for that specific
 * lookup's own result (via `_cb`) and, only if it settles with no url AND the sheet is still open on this
 * same album (the user may have already moved on with Prev/Next or closed it), shows an inline, dismissable
 * "Couldn't find a cover" row with a manual "Choose one…" action — never an auto-opened <dialog>, so it
 * can't steal focus or block input; a confirmed miss is a plain-English status, same register as every
 * other sheet affordance. `onSheetCoverMiss` is consumed by js/ui/extras.js, which already owns
 * `openPosterChoice` (so the dialog-opening code isn't duplicated) and already wraps `Sheet.open` to track
 * `curAlbum`. #sheetCoverMiss is reset to hidden every time the sheet opens, including for an album whose
 * cover resolves instantly from cache (the common case), so most opens never show it. UNTESTED: the real
 * cover-provider network calls this depends on are unverified in every slice since Slice 1 (no network in
 * this sandbox) — see "What's verified" below for what WAS exercised in a real browser this slice (a stubbed
 * miss, and confirming grid scrolling never triggers this).
 */
let sheetCoverMissHook = null;
export const onSheetCoverMiss = (fn) => { sheetCoverMissHook = fn; };
function openSheetImpl(a, why) {
  if (!$('#sheet').classList.contains('open')) lastFocus = document.activeElement;
  $('#sheetPoster').querySelectorAll('.poster').forEach(releaseArt); sheetAlbum = a;
  const missEl = $('#sheetCoverMiss'); if (missEl) missEl.hidden = true;
  resetSynopsisUI();
  const p = makePoster(a, { eager: true });
  // makePoster(eager) already called Art.want(a, p._cb, true) with its own display callback; Art.want's
  // contract (js/main.js's Art wrapper over js/covers/service.js) allows multiple callbacks per album id
  // (a Set, see createCoverService's `want`), so adding a second one here observes the SAME in-flight
  // lookup rather than starting a duplicate network round of requests.
  Art.want(a, (url) => { if (sheetAlbum === a && !url && missEl) { missEl.hidden = false; sheetCoverMissHook && sheetCoverMissHook(a); } }, true);
  $('#sheetPoster').replaceChildren(p);
  $('#sheetTitle').textContent = a.title; $('#sheetSub').textContent = `${a.artist} · ${a.year || 'Year unknown'}`;
  const tags = $('#sheetTags'); tags.replaceChildren();
  for (const t of [titleCase(a.section), a.sub, a.year ? Math.floor(a.year / 10) * 10 + 's' : null]) if (t) { const s = document.createElement('span'); s.className = 'tag'; s.textContent = t; tags.appendChild(s); }
  const w = $('#sheetWhy'); w.hidden = !why; if (why) w.textContent = 'Why this: ' + why;
  fillSheetOwn();
  const svc = $('#sheetServices'); svc.replaceChildren();
  for (const s of serviceLinks(a)) {
    const l = document.createElement('a'); l.className = 'service-link'; l.href = s.url; l.target = '_blank'; l.rel = 'noopener noreferrer';
    l.setAttribute('aria-label', `Search ${a.title} on ${s.name}`);
    const g = document.createElement('span'); g.className = 'glyph'; g.textContent = s.glyph; g.setAttribute('aria-hidden', 'true');
    const n = document.createElement('span'); n.textContent = s.name; l.append(g, n); svc.appendChild(l);
  }
  $('#scrim').classList.add('open'); $('#sheet').classList.add('open'); document.body.classList.add('sheet-open'); $('#app').inert = true;
  syncNav(); $('#sheetClose').focus();
}
function closeSheetImpl() {
  if (!$('#sheet').classList.contains('open')) return;
  $('#scrim').classList.remove('open'); $('#sheet').classList.remove('open'); document.body.classList.remove('sheet-open'); $('#app').inert = false;
  $('#sheetPoster').querySelectorAll('.poster').forEach(releaseArt); sheetAlbum = null;
  resetSynopsisUI();
  if (S.own !== 'all') App.renderList();
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}
/**
 * Synopsis quality (brief item 5), UI half. js/ai/smartpicks.js's `generateSynopsis` (generate -> post-
 * check -> regenerate once -> provider description -> stub) existed since Slice 10 but was deliberately
 * left unwired because the app's stated privacy promise is "nothing is sent until you press [a button]" —
 * auto-fetching on sheet-open would break that. This wires it as exactly that: a manual button, same
 * register as "Use my cover"/"Change poster". `sheetSynSeq` is the same superseded-response guard pattern
 * `validateKey` above already uses for AI calls (a later click, Prev/Next, or sheet-close must not let an
 * earlier request's late result land in the wrong place) plus an AbortController so switching sheets
 * actually cancels the in-flight fetch rather than just ignoring its result. UNTESTED: real AI provider
 * responses (no network/key in this sandbox, same as every prior AI-touching slice) — what IS verified in
 * the browser this slice is the full loading -> stub-fallback path with no key configured, and the
 * open-A-click-switch-to-B race not clobbering B (see docs/DEVLOG.md).
 */
let sheetSynSeq = 0, sheetSynCtl = null;
function resetSynopsisUI() {
  sheetSynCtl?.abort(); sheetSynCtl = null; sheetSynSeq++;
  const el = $('#sheetSynopsis'); if (el) { el.hidden = true; el.removeAttribute('data-state'); el.textContent = ''; }
}
async function runSynopsis(a) {
  const el = $('#sheetSynopsis'); if (!el) return;
  const seq = ++sheetSynSeq;
  sheetSynCtl?.abort(); sheetSynCtl = new AbortController();
  el.hidden = false; el.dataset.state = 'loading'; el.textContent = 'Writing a synopsis…';
  const chain = aiChain(aiCfg(), keyOf);
  if (!chain.length) {
    el.removeAttribute('data-state'); el.textContent = synopsisStub(a);
    return;
  }
  try {
    const { text } = await generateSynopsis((link, system, user, signal) => chat(link, system, user, signal), chain[0], a, sheetSynCtl.signal);
    if (seq !== sheetSynSeq) return; // sheet moved on (Prev/Next, close, or a second click) before this settled
    el.removeAttribute('data-state'); el.textContent = text;
  } catch (e) {
    if (seq !== sheetSynSeq) return;
    if (e.name === 'AbortError') return; // cancelled by a newer request; resetSynopsisUI already cleared the row
    el.removeAttribute('data-state'); el.textContent = synopsisStub(a);
  }
}
export const Sheet = { open: openSheetImpl, close: closeSheetImpl };
$('#scrim').addEventListener('click', () => Sheet.close()); $('#sheetClose').addEventListener('click', () => Sheet.close());
$('#sheetOwnBtn').addEventListener('click', () => { if (sheetAlbum) toggleOwnedWithPulse($('#sheetOwnBtn'), sheetAlbum, { silent: true }); });
$('#sheetMoreBtn').addEventListener('click', () => {
  if (!sheetAlbum) return; const a = sheetAlbum, snap = filterSnap(); S.query = a.artist; S.section = 'all'; S.decade = 'all'; S.own = 'all';
  $('#search').value = a.artist; $('#clearSearch').classList.add('show'); $('#genreSel').value = 'all'; $('#ownSel').value = 'all'; syncChips();
  lastFocus = null; Sheet.close(); App.renderList(); window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('Showing ' + a.artist, { label: 'Undo', fn: () => applyFilterSnap(snap) });
});
export const getSheetAlbum = () => sheetAlbum;
export function requestSynopsis() { if (sheetAlbum) runSynopsis(sheetAlbum); }

/* =====================================================================
   LOADING: fetch albums.md (same folder) -> cached copy -> file picker / drop
   Uses js/parser/formats.js's importText for every format, including the
   app's own default load — one parser, one code path (v4 spec 2).
   ===================================================================== */
const safeSrc = (s) => /^[\w][\w.\- /]*\.(md|markdown|txt)$/i.test(s) && !s.includes('..') && !s.includes('//');
function applyTextImpl(text, name, kind, parsed) {
  let res;
  try { res = parsed || importText(name, text); } catch (e) { toast('Could not read ' + name + ': ' + String(e.message || e)); return false; }
  if (!res.albums.length) { toast('No albums found in ' + name); return false; }
  for (const a of res.albums) a.hay = norm(`${a.artist} ${a.title} ${a.year || ''} ${a.section}`);
  S.albums = res.albums; S.byId = new Map(res.albums.map((a) => [a.id, a])); S.skipped = res.skipped; S.source = name; S.sourceKind = kind; S.lastText = text;
  const secs = []; for (const a of res.albums) if (!secs.includes(a.section)) secs.push(a.section);
  const u = secs.indexOf(UNSORTED); if (u >= 0) { secs.splice(u, 1); secs.push(UNSORTED); } S.sections = secs;
  S.decades = [...new Set(res.albums.filter((a) => a.year).map((a) => Math.floor(a.year / 10) * 10))].sort((a, b) => a - b);
  S.hasUnknownYear = res.albums.some((a) => !a.year);
  ['exportBtn', 'retryBtn', 'surpriseBtn', 'collapseBtn'].forEach((id) => { $('#' + id).disabled = false; });
  buildCards(); renderFilters(); renderStats(); renderRecs(); App.renderList();
  const inferred = res.albums.filter((a) => a.inferred).length, uns = res.albums.filter((a) => a.section === UNSORTED).length;
  $('#footCount').textContent = `${res.albums.length} albums · ${secs.length} genres · from ${name}` + (inferred ? ` · ${inferred} genre${inferred > 1 ? 's' : ''} inferred` + (uns ? ` (${uns} unsorted)` : '') : '');
  const box = $('#skippedBox'); box.hidden = !res.skipped.length;
  if (res.skipped.length) { $('#skippedSum').textContent = `${res.skipped.length} line${res.skipped.length > 1 ? 's' : ''} skipped`; $('#skippedList').replaceChildren(...res.skipped.slice(0, 200).map((s) => { const li = document.createElement('li'); li.textContent = `${s.n ? 'Line ' + s.n + ': ' : ''}${s.text} — ${s.reason}`; return li; })); }
  return true;
}
export const App = { applyText: applyTextImpl, renderList };

/**
 * One-directional cloud sync -> app (never app -> cloud). Patches the DOM instead of a full rebuild:
 * see js/ui/patch.js for the diff/apply split (v4 spec 3). Returns the diff so the caller (js/ui/extras.js)
 * can show the "+a, -r, ~c" toast and the Review dialog with exact before/after.
 */
export function syncAlbums(newAlbumsIn, { name, kind = 'cloud', text = '' } = {}) {
  const newAlbums = newAlbumsIn.map((a) => ({ ...a, hay: norm(`${a.artist} ${a.title} ${a.year || ''} ${a.section}`) }));
  const diff = diffAlbums(S.albums, newAlbums);
  patchMod.applyPatchToDom(diff, {
    S, cards, buildCard, releaseArt, paintOwned,
    removeFromSelection: (id) => removeFromSelectionHook && removeFromSelectionHook(id),
  });
  S.source = name; S.sourceKind = kind; S.lastText = text;
  const secs = []; for (const a of S.albums) if (!secs.includes(a.section)) secs.push(a.section);
  const u = secs.indexOf(UNSORTED); if (u >= 0) { secs.splice(u, 1); secs.push(UNSORTED); } S.sections = secs;
  S.decades = [...new Set(S.albums.filter((a) => a.year).map((a) => Math.floor(a.year / 10) * 10))].sort((a, b) => a - b);
  S.hasUnknownYear = S.albums.some((a) => !a.year);
  ['exportBtn', 'retryBtn', 'surpriseBtn', 'collapseBtn'].forEach((id) => { $('#' + id).disabled = false; });
  renderFilters(); renderStats();
  clearTimeout(recTimer); recTimer = setTimeout(renderRecs, 400);
  App.renderList();
  $('#footCount').textContent = `${S.albums.length} albums · ${secs.length} genres · from ${name}`;
  return diff;
}
export { diffAlbums, summarizeDiff };
let removeFromSelectionHook = null;
export const onAlbumRemoved = (fn) => { removeFromSelectionHook = fn; };

function showState(build) { const d = document.createElement('div'); d.className = 'state'; build(d); listEl.replaceChildren(d); return d; }
function showLoadError(err) {
  const d = showState((d) => {
    const b = document.createElement('b'); b.textContent = "Couldn't load your albums";
    const errMsg = document.createElement('span'); errMsg.id = 'errMsg';
    const code = document.createElement('code'); code.textContent = 'py -m http.server 8000';
    const btn = document.createElement('button'); btn.className = 'btn primary'; btn.id = 'emptyLoad'; btn.type = 'button'; btn.textContent = 'Choose albums .md';
    d.append(b, errMsg, document.createElement('br'), code, document.createElement('br'),
      'Run that in this folder, then open http://localhost:8000/ — browsers block reading albums.md straight from a file:// page. Or load the file manually:',
      document.createElement('br'), btn);
  });
  d.querySelector('#errMsg').textContent = ` ${err && err.message ? err.message : err}. Expected a file named "${new URLSearchParams(location.search).get('src') || 'albums.md'}" next to this page.`;
  d.querySelector('#emptyLoad').addEventListener('click', () => $('#fileInput').click());
  $('#subcount').textContent = 'No albums loaded';
}
async function fetchSource() {
  const q = new URLSearchParams(location.search).get('src'), src = q && safeSrc(q) ? q : 'albums.md';
  const r = await fetch(src, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status === 404 ? 'File not found (HTTP 404)' : 'HTTP ' + r.status);
  return { text: await r.text(), name: src };
}
/** True when the user has a cloud/provider source configured (js/ui/extras.js's initSource owns loading
 * it). boot() must not race that load with its own default fetch of albums.md: Slice 3 flagged that if
 * albums.md is missing, this file's own load error/saved-copy fallback can fire after an early cloud
 * result and clobber it with a full applyText() rebuild. Skipping the default fetch whenever a cloud
 * source is configured removes the race instead of trying to referee two async sources of truth. */
const hasCloudSource = () => shouldSkipDefaultLoad(lsGet('crate.cloud', ''), lsGet('crate.cloud.provider', ''), new URLSearchParams(location.search).get('src'));
async function boot() {
  const body = document.createElement('div'); body.className = 'section-body'; body.setAttribute('aria-busy', 'true');
  for (let i = 0; i < 18; i++) body.appendChild(Object.assign(document.createElement('div'), { className: 'skel' }));
  listEl.replaceChildren(body);
  if (hasCloudSource()) return;
  try { const { text, name } = await fetchSource(); if (App.applyText(text, name, 'fetch')) { lsSet('crate.md.v1', JSON.stringify({ name, text })); return; } throw new Error('No albums recognised in ' + name); }
  catch (err) {
    let saved = null; try { saved = JSON.parse(lsGet('crate.md.v1', 'null')); } catch { /* none saved */ }
    if (saved && saved.text && App.applyText(saved.text, saved.name + ' (saved copy)', 'saved')) toast('Using saved copy — could not read ' + saved.name);
    else showLoadError(err);
  }
}
async function reloadSource(manual) {
  if (S.sourceKind === 'file') { if (manual) $('#fileInput').click(); return; }
  try {
    const { text, name } = await fetchSource();
    if (text === S.lastText) { if (manual) toast('Already up to date'); return; }
    if (App.applyText(text, name, 'fetch')) { lsSet('crate.md.v1', JSON.stringify({ name, text })); toast(name + ' updated'); }
  } catch (e) { if (manual) toast('Reload failed: ' + String(e.message || e)); }
}
function loadFile(f) {
  if (!f) return; if (f.size > 8e6) return toast('File too large');
  const r = new FileReader(); r.onerror = () => toast('Could not read file');
  r.onload = () => {
    const prev = S.lastText ? { text: S.lastText, name: S.source, kind: S.sourceKind } : null;
    if (!App.applyText(String(r.result), f.name, 'file')) return;
    lsSet('crate.md.v1', JSON.stringify({ name: f.name, text: String(r.result) }));
    if (prev) toast('Loaded ' + f.name, { label: 'Undo', fn: () => { if (App.applyText(prev.text, prev.name, prev.kind)) lsSet('crate.md.v1', JSON.stringify({ name: prev.name, text: prev.text })); } });
  };
  r.readAsText(f);
}
$('#loadBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
$('#reloadBtn').addEventListener('click', () => reloadSource(true));
$('#retryBtn').addEventListener('click', () => {
  Art.retryMissing(); let n = 0;
  document.querySelectorAll('.poster').forEach((p) => { if (p._art !== 'none') return; p._art = null; n++;
    const r = p.getBoundingClientRect(); if (p._painted && r.bottom > -250 && r.top < innerHeight + 250) requestArt(p); });
  toast(n ? `Retrying ${n} cover${n > 1 ? 's' : ''}` : 'No missing covers');
});
let dragN = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragN++; $('#dropzone').classList.add('show'); } });
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#dropzone').classList.remove('show'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragN = 0; $('#dropzone').classList.remove('show'); loadFile(e.dataTransfer.files[0]); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.sourceKind === 'fetch') reloadSource(false); });

$('#exportBtn').addEventListener('click', () => {
  if (!S.albums.length) return;
  const out = [], by = new Map(); for (const a of S.albums) { if (!by.has(a.section)) by.set(a.section, []); by.get(a.section).push(a); }
  for (const s of S.sections) { if (!by.has(s)) continue; out.push(s, ''); for (const a of by.get(s)) out.push(`* ${isOwned(a) ? '[x] ' : ''}${a.sub ? a.sub + ' — ' : ''}${a.artist} - ${a.title}${a.year ? ` (${a.year})` : ''}`); out.push(''); }
  const url = URL.createObjectURL(new Blob([out.join('\n')], { type: 'text/markdown' })), l = document.createElement('a');
  l.href = url; l.download = 'albums-crate.md'; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Exported with [x] ownership markers');
});

/* =====================================================================
   CONTROLS
   ===================================================================== */
let toastT;
export function toast(msg, act, act2) {
  const t = $('#toast'), b = $('#toastAct'), b2 = $('#toastAct2');
  $('#toastMsg').textContent = msg;
  b.hidden = !act; b.onclick = act ? () => { t.classList.remove('show', 'has-act'); act.fn(); } : null; if (act) b.textContent = act.label;
  b2.hidden = !act2; b2.onclick = act2 ? () => { t.classList.remove('show', 'has-act'); act2.fn(); } : null; if (act2) b2.textContent = act2.label;
  t.classList.add('show'); t.classList.toggle('has-act', !!(act || act2)); clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show', 'has-act'), (act || act2) ? 7000 : 1900);
}
let searchT; $('#search').addEventListener('input', (e) => { S.query = e.target.value; $('#clearSearch').classList.toggle('show', !!S.query); clearTimeout(searchT); searchT = setTimeout(() => App.renderList(), 120); });
$('#clearSearch').addEventListener('click', () => { S.query = ''; $('#search').value = ''; $('#clearSearch').classList.remove('show'); App.renderList(); $('#search').focus(); });
$('#genreSel').addEventListener('change', (e) => { S.section = e.target.value; App.renderList(); renderGenreList(); });
$('#ownSel').addEventListener('change', (e) => { S.own = e.target.value; App.renderList(); });

const SORTS = [['taxonomy', 'Genre order'], ['az', 'Artist A–Z'], ['year', 'Year']];
/** FLIP reorder: records where today's visible cards are, re-renders, then animates the delta — one
 * concrete, reduced-motion-guarded "layout animation on reorder" (v4 spec 4), not just a fade. */
function flipReorder(run) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { run(); return; }
  const before = new Map();
  for (const el of listEl.querySelectorAll('.card')) before.set(el.dataset.id, el.getBoundingClientRect());
  run();
  for (const el of listEl.querySelectorAll('.card')) {
    const old = before.get(el.dataset.id); if (!old) continue;
    const now = el.getBoundingClientRect(), dx = old.left - now.left, dy = old.top - now.top;
    if (!dx && !dy) continue;
    el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
$('#sortBtn').addEventListener('click', () => { const i = SORTS.findIndex((s) => s[0] === S.sort); const n = SORTS[(i + 1) % SORTS.length]; S.sort = n[0]; lsSet('crate.sort', S.sort); toast('Sort: ' + n[1]); flipReorder(() => App.renderList()); });
if (!SORTS.some((s) => s[0] === S.sort)) S.sort = 'taxonomy';
$('#viewToggle').addEventListener('click', () => { const on = document.body.classList.toggle('dense'); $('#viewToggle').setAttribute('aria-pressed', String(on)); lsSet('crate.dense', on ? '1' : '0'); });
if (lsGet('crate.dense', '0') === '1') { document.body.classList.add('dense'); $('#viewToggle').setAttribute('aria-pressed', 'true'); }
{ const t = lsGet('crate.theme', ''); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; }
$('#themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next; lsSet('crate.theme', next);
});
addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName), open = $('#sheet').classList.contains('open');
  if (e.key === 'Escape') { if (open && !$('#help').open) Sheet.close(); else if (document.activeElement === $('#search') && S.query) $('#clearSearch').click(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); }
  else if (typing || e.ctrlKey || e.metaKey || e.altKey || $('#help').open) return;
  else if (open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); sheetNav(e.key === 'ArrowRight' ? 1 : -1); }
  else if (!open && e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === '?') $('#help').showModal();
});
// Sticky header elevation (brief item 1): #topbar is position:sticky inside the document's normal scroll
// container (the page itself scrolls — #app/body have no overflow:auto of their own, confirmed in
// index.html's CSS), so a window scroll listener is the right one here, not an inner div. Threshold
// matches the brief's "past 8px".
addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', scrollY > 8), { passive: true });
const syncTop = () => document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px');
if (window.ResizeObserver) new ResizeObserver(syncTop).observe($('#topbar')); else addEventListener('resize', syncTop);
syncTop();
Art.status.onChange = (s) => {
  const el = $('#artStatus');
  el.textContent = `Cover art: ${s.found} found` + (s.queued ? ` · ${s.queued} queued` : '') + (s.offline ? ' · offline' : s.paused ? ' · rate-limited, retrying shortly' : '');
};

const undoStack = [];
const syncUndo = () => { $('#undoBtn').disabled = !undoStack.length; };
function applyOwn(pairs) {
  for (const [a, v] of pairs) { if (v === undefined) delete S.ownMap[a.id]; else S.ownMap[a.id] = v; paintOwned(a); }
  lsSet('crate.own.v2', JSON.stringify(S.ownMap)); renderStats();
  clearTimeout(recTimer); recTimer = setTimeout(renderRecs, 1500); if (sheetAlbum) fillSheetOwn();
}
export function commitOwn(changes) {
  const prev = changes.map(([a]) => [a, a.id in S.ownMap ? S.ownMap[a.id] : undefined]);
  applyOwn(changes.map(([a, v]) => [a, v ? 1 : 0]));
  undoStack.push(prev); if (undoStack.length > 50) undoStack.shift(); syncUndo();
}
export function undo() {
  const prev = undoStack.pop(); if (!prev) return toast('Nothing to undo');
  applyOwn(prev); syncUndo(); if (S.own !== 'all' || prev.length > 1) App.renderList();
  toast(`Undid change to ${prev.length} album${prev.length > 1 ? 's' : ''}`);
}
export const filterSnap = () => ({ query: S.query, section: S.section, decade: S.decade, own: S.own });
const activeFilters = () => (S.query ? 1 : 0) + (S.section !== 'all') + (S.decade !== 'all') + (S.own !== 'all');
export function applyFilterSnap(snap) {
  Object.assign(S, snap); $('#search').value = S.query; $('#clearSearch').classList.toggle('show', !!S.query);
  $('#genreSel').value = S.section; $('#ownSel').value = S.own; syncChips(); App.renderList();
}
function clearFilters() {
  const snap = filterSnap(); if (!activeFilters()) return;
  applyFilterSnap({ query: '', section: 'all', decade: 'all', own: 'all' });
  toast('Filters cleared', { label: 'Undo', fn: () => applyFilterSnap(snap) });
}
function syncClear() { const n = activeFilters(), b = $('#clearFilters'); b.hidden = !n; b.textContent = `Clear ${n} filter${n > 1 ? 's' : ''}`; }
const navIds = () => [...listEl.querySelectorAll('.section-body:not(.collapsed) .card')].map((c) => c.dataset.id);
function syncNav() { const ids = navIds(), i = sheetAlbum ? ids.indexOf(sheetAlbum.id) : -1; $('#sheetPrev').disabled = i < 1; $('#sheetNext').disabled = i < 0 || i >= ids.length - 1; }
function sheetNav(d) { const ids = navIds(), i = ids.indexOf(sheetAlbum && sheetAlbum.id), next = S.byId.get(ids[i + d]); if (i >= 0 && next) Sheet.open(next); }
$('#sheetPrev').addEventListener('click', () => sheetNav(-1));
$('#sheetNext').addEventListener('click', () => sheetNav(1));
$('#undoBtn').addEventListener('click', undo);
$('#clearFilters').addEventListener('click', clearFilters);
$('#helpBtn').addEventListener('click', () => $('#help').showModal());
$('#helpClose').addEventListener('click', () => $('#help').close());
$('#help').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#collapseBtn').addEventListener('click', () => {
  if (S.sort !== 'taxonomy') return toast('Switch to genre order to collapse sections');
  if (S.collapsed.size < S.sections.length) S.sections.forEach((x) => S.collapsed.add(x)); else S.collapsed.clear();
  lsSet('crate.collapsed', JSON.stringify([...S.collapsed])); App.renderList();
});
$('#surpriseBtn').addEventListener('click', () => {
  const pool = S.albums.filter((a) => !isOwned(a)); if (!pool.length) return toast('Every album is already in your crate');
  Sheet.open(pool[Math.floor(Math.random() * pool.length)], 'a random pick from albums you do not own yet');
});
{
  const sheet = $('#sheet'), grabber = sheet.querySelector('.grabber'); let startY = null, dy = 0;
  grabber.addEventListener('pointerdown', (e) => { startY = e.clientY; dy = 0; grabber.setPointerCapture(e.pointerId); sheet.classList.add('dragging'); });
  grabber.addEventListener('pointermove', (e) => { if (startY === null) return; dy = Math.max(0, e.clientY - startY); sheet.style.transform = `translateY(${dy}px)`; });
  const endDrag = () => { if (startY === null) return; startY = null; sheet.classList.remove('dragging'); sheet.style.transform = ''; if (dy > 90) Sheet.close(); };
  grabber.addEventListener('pointerup', endDrag); grabber.addEventListener('pointercancel', endDrag);
}

/* =====================================================================
   SIDEBAR / MOBILE FILTER SHEET (v4 spec 4)
   ===================================================================== */
const filterToggle = $('#filterToggle'), sidebar = $('#sidebar'), filterScrim = $('#filterScrim');
function openFilterSheet() { sidebar.classList.add('open'); filterScrim.classList.add('open'); filterToggle?.setAttribute('aria-expanded', 'true'); }
function closeFilterSheet() { sidebar.classList.remove('open'); filterScrim.classList.remove('open'); filterToggle?.setAttribute('aria-expanded', 'false'); }
filterToggle?.addEventListener('click', () => { sidebar.classList.contains('open') ? closeFilterSheet() : openFilterSheet(); });
filterScrim?.addEventListener('click', closeFilterSheet);
$('#sidebarClose')?.addEventListener('click', closeFilterSheet);
addEventListener('keydown', (e) => { if (e.key === 'Escape' && sidebar?.classList.contains('open')) closeFilterSheet(); });

/* =====================================================================
   AI SMART PICKS — provider plumbing lives in js/ai/smartpicks.js; this
   wires it to the DOM (dialog, rail, prompt box).
   ===================================================================== */
const aiCfg = () => { try { return JSON.parse(lsGet('crate.ai', '{}')) || {}; } catch { return {}; } };
function aiCandidatePool() {
  const pool = recommend(120).map((x) => x.a), seen = new Set(pool.map((a) => a.id));
  for (const a of S.albums) { if (pool.length >= 150) break; if (!isOwned(a) && !seen.has(a.id)) pool.push(a); }
  return pool;
}
const aiWrap = $('#aiWrap');
function setPicks(...nodes) { aiWrap.querySelectorAll('.poster').forEach(releaseArt); aiWrap.replaceChildren(...nodes); }
let shownPickIds = new Set(); // ids already on the rail, so "Brainstorm more" never repeats a card
function makePickCard(a, why) {
  const c = document.createElement('div'); c.className = 'rec-card'; c.tabIndex = 0; c.setAttribute('role', 'button');
  const p = makePoster(a), w = document.createElement('div'); w.className = 'rec-why'; w.textContent = why; w.title = why; p.appendChild(w);
  const t = document.createElement('div'); t.className = 'card-title'; t.textContent = a.title; t.style.marginTop = '8px';
  const r = document.createElement('div'); r.className = 'card-artist'; r.textContent = a.artist + ' · ' + (a.year || '—');
  c.append(p, t, r); c.addEventListener('click', () => Sheet.open(a, why));
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Sheet.open(a, why); } });
  return c;
}
function renderPicks(picks, want, via) {
  shownPickIds = new Set(picks.map(({ a }) => a.id));
  const head = document.createElement('div'); head.className = 'rail-head';
  const h = document.createElement('h2'); h.textContent = 'What to listen to today';
  const sub = document.createElement('span'); sub.textContent = (want ? want.slice(0, 40) : 'Tailored to your crate') + ' · via ' + PROVIDERS[via].n;
  const more = document.createElement('button'); more.type = 'button'; more.className = 'sec-act'; more.textContent = 'Brainstorm more'; more.id = 'aiMore';
  more.addEventListener('click', () => runSmartPicks({ append: true, want, via }));
  const x = document.createElement('button'); x.type = 'button'; x.className = 'sec-act'; x.textContent = 'Dismiss'; x.addEventListener('click', () => setPicks());
  const left = document.createElement('div'); left.append(h); head.append(left, sub, more, x);
  const rail = document.createElement('div'); rail.className = 'rail';
  for (const { a, why } of picks) rail.appendChild(makePickCard(a, why));
  setPicks(head, rail);
}
function appendPicks(picks) {
  const rail = aiWrap.querySelector('.rail'); if (!rail) return; // rail only missing if dismissed mid-request; drop the stale append
  const fresh = picks.filter(({ a }) => !shownPickIds.has(a.id));
  if (!fresh.length) return toast('No new matches left in your crate for this prompt');
  for (const { a, why } of fresh) { shownPickIds.add(a.id); rail.appendChild(makePickCard(a, why)); }
}
let aiCtl = null;
async function runSmartPicks({ append = false, want: reuseWant, via: reuseVia } = {}) {
  if (aiCtl) return aiCtl.abort();
  if (!S.albums.length) return toast('Load your albums first');
  const chain = aiChain(aiCfg(), keyOf); if (!chain.length) { toast('Add an API key and model first'); return openAi(); }
  const typed = append ? reuseWant : $('#aiPrompt').value.trim();
  // Flexible seed parsing: only rewrite the prompt when the typed text actually looks like a structured
  // "Artist - Title" (etc.) line — resolveFreeform then finds the best crate match or crate-agnostic guess
  // and we hand the model a clean "similar to X by Y" seed instead of the raw separator the person typed.
  // A free-text mood prompt ("moody 80s post-punk") has no separator, so parseFreeformQuery returns an
  // artist-less guess and this is a no-op — existing behaviour for that case is unchanged.
  let want = typed;
  if (!append && typed) {
    const { album, query } = resolveFreeform(typed, S.albums);
    if (album) want = `albums similar to ${album.artist} - ${album.title}`;
    else if (query?.artist) want = `albums similar to ${query.artist} - ${query.title}`;
  }
  const bar = $('#aiBar'), go = $('#aiGo'), prev = [...aiWrap.childNodes];
  aiCtl = new AbortController(); bar.classList.add('loading'); if (!append) go.textContent = 'Cancel';
  if (!append) { const sk = document.createElement('div'); sk.className = 'rail'; sk.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 7; i++) sk.appendChild(Object.assign(document.createElement('div'), { className: 'skel' }));
    setPicks(sk); }
  else { const moreBtn = $('#aiMore'); if (moreBtn) busy(moreBtn, true, 'Brainstorm more'); }
  try {
    const pool = append ? aiCandidatePool().filter((a) => !shownPickIds.has(a.id)) : aiCandidatePool();
    const { picks, via } = await askModel(chain, S.albums.filter(isOwned), pool, want, aiCtl.signal);
    if (append) appendPicks(picks); else { renderPicks(picks, want, via); toast('Smart picks via ' + PROVIDERS[via].n); }
  } catch (e) {
    if (append) toast(e.name === 'AbortError' ? 'Cancelled' : String(e.message || e).slice(0, 160));
    else { aiWrap.replaceChildren(...prev); toast(e.name === 'AbortError' ? 'Cancelled' : String(e.message || e).slice(0, 160)); }
  } finally {
    aiCtl = null; bar.classList.remove('loading'); if (!append) go.textContent = '✦ Smart picks';
    const moreBtn = $('#aiMore'); if (append && moreBtn) busy(moreBtn, false, 'Brainstorm more');
  }
}
$('#aiGo').addEventListener('click', runSmartPicks);
$('#aiPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSmartPicks(); } });

const aiEl = { prov: $('#aiProv'), key: $('#aiKey'), model: $('#aiModel'), rem: $('#aiRemember'), note: $('#aiNote'), icon: $('#aiStatusIcon') };
/** Sets both the icon and the text together so they can never show contradictory states (brief item 4,
 * cosmetic half — Slice 10 built the logic and reused #aiNote as plain text; this adds the spinner/check/
 * cross affordance on top without dropping the text, which stays the detailed, provider-specific message). */
function setAiStatus(state, text) { if (aiEl.icon) aiEl.icon.dataset.state = state || ''; aiEl.note.textContent = text; }
function fillProv() {
  const cur = aiEl.prov.value || aiCfg().provider || 'groq', models = aiCfg().models || {};
  aiEl.prov.replaceChildren(...Object.entries(PROVIDERS).map(([id, P]) => { const o = document.createElement('option'); o.value = id; o.textContent = P.n + ((keyOf(id) || P.nokey) && models[id] ? ' ✓' : ''); return o; }));
  aiEl.prov.value = cur;
}
function aiLoad() {
  const p = aiEl.prov.value, P = PROVIDERS[p];
  aiEl.key.value = keyOf(p); aiEl.key.disabled = !!P.nokey; aiEl.key.type = 'password'; $('#aiShow').textContent = 'Show';
  aiEl.model.value = (aiCfg().models || {})[p] || ''; aiEl.rem.checked = keyRemembered(p); $('#aiModels').replaceChildren();
  setAiStatus('', (P.note ? P.note + ' ' : '') + 'Endpoint: ' + P.u + '. Nothing is sent until you press Smart picks or Test.');
}
function openAi() { fillProv(); aiLoad(); $('#ai').showModal(); }
const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = on ? '…' : label; };
aiEl.prov.addEventListener('change', aiLoad);
$('#aiBtn').addEventListener('click', openAi);

/**
 * Single-key provider setup (brief item 4): paste a key, guess the provider from its shape, then validate
 * it with one lightweight `chat()` call before anyone presses Save. The manual provider dropdown
 * (aiEl.prov) stays visible and authoritative for the three providers whose key shape isn't
 * distinguishable (see detectKeyProvider's doc comment) and as a correction if the guess is wrong — this
 * collapses the common case to one field without removing the fallback the brief asks to keep.
 * The validation call reuses js/covers/limiter.js's circuit breaker/backoff (one call per provider id,
 * shared across repeated keystrokes) instead of a second rate-limiting implementation.
 */
const keyCheckLimiters = new Map();
const limiterFor = (p) => { if (!keyCheckLimiters.has(p)) keyCheckLimiters.set(p, createLimiter({ ratePerSec: 0.5, burst: 1, failThreshold: 3, cooldownMs: 30000 })); return keyCheckLimiters.get(p); };
let keyCheckSeq = 0;
async function validateKey(p, key, model) {
  const seq = ++keyCheckSeq;
  if (!model) { setAiStatus('', 'Choose a model (use Fetch) before the key can be validated.'); return; }
  const limiter = limiterFor(p);
  if (limiter.isOpen()) { setAiStatus('error', `${PROVIDERS[p].n}: too many recent failures, try again shortly.`); return; }
  setAiStatus('checking', `Checking the ${PROVIDERS[p].n} key…`);
  try {
    await limiter.acquire();
    await chat({ p, key, model }, 'Reply with the single word OK.', 'ping');
    if (seq !== keyCheckSeq) return; // a newer keystroke/provider superseded this check
    limiter.success();
    setAiStatus('ok', `Looks like a valid ${PROVIDERS[p].n} key.`);
  } catch (e) {
    if (seq !== keyCheckSeq) return;
    limiter.failure();
    setAiStatus('error', `${PROVIDERS[p].n} rejected this key: ${String(e.message || e).slice(0, 140)}`);
  }
}
let keyDetectT;
aiEl.key.addEventListener('input', () => {
  clearTimeout(keyDetectT);
  const raw = aiEl.key.value.trim();
  if (!raw) return;
  keyDetectT = setTimeout(() => {
    const guess = detectKeyProvider(raw);
    if (guess && guess !== aiEl.prov.value) {
      aiEl.prov.value = guess; aiLoad(); aiEl.key.value = raw;
      setAiStatus('', `Detected a ${PROVIDERS[guess].n} key.`);
    } else if (!guess) {
      setAiStatus('', `Could not tell which provider this key is for from its shape — pick one above.`);
      return;
    }
    const model = aiEl.model.value.trim();
    if (model) validateKey(aiEl.prov.value, raw, model);
  }, 500);
});
$('#ai').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#aiShow').addEventListener('click', () => { const hide = aiEl.key.type === 'text'; aiEl.key.type = hide ? 'password' : 'text'; $('#aiShow').textContent = hide ? 'Show' : 'Hide'; });
$('#aiFetch').addEventListener('click', async () => {
  const p = aiEl.prov.value, btn = $('#aiFetch'); busy(btn, true, 'Fetch');
  try { const ids = await listModels(p, aiEl.key.value.trim());
    $('#aiModels').replaceChildren(...ids.map((id) => { const o = document.createElement('option'); o.value = id; return o; })); toast(`${ids.length} models found`); }
  catch (e) { toast(String(e.message || e).slice(0, 160)); } finally { busy(btn, false, 'Fetch'); }
});
$('#aiTest').addEventListener('click', async () => {
  const p = aiEl.prov.value, btn = $('#aiTest'), model = aiEl.model.value.trim(); if (!model) return toast('Choose a model first');
  busy(btn, true, 'Test');
  try { await chat({ p, key: aiEl.key.value.trim(), model }, 'Reply with the single word OK.', 'ping'); toast('Connection works'); }
  catch (e) { toast(String(e.message || e).slice(0, 160)); } finally { busy(btn, false, 'Test'); }
});
$('#aiSave').addEventListener('click', () => {
  const p = aiEl.prov.value, P = PROVIDERS[p], key = aiEl.key.value.trim(), model = aiEl.model.value.trim();
  if (!P.nokey && !key) return toast('Enter an API key'); if (!model) return toast('Choose a model (use Fetch)');
  const c = aiCfg(); c.provider = p; c.models = { ...c.models, [p]: model }; lsSet('crate.ai', JSON.stringify(c)); saveKey(p, key, aiEl.rem.checked);
  fillProv(); $('#ai').close(); toast(P.n + ' is ready');
});
$('#aiForget').addEventListener('click', () => { saveKey(aiEl.prov.value, ''); aiEl.key.value = ''; fillProv(); toast('Key removed from this browser'); });

boot();
