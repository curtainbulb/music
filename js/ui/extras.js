import { importText, applyImport, MAX_BYTES } from '../parser/formats.js';
import { toMarkdown, toCsv, toJson, ownershipToJson, ownershipFromJson } from '../parser/export.js';
import { normalizeShareUrl } from '../sources/links.js';
import { createCloudSource } from '../sources/cloud.js';
import { createKv } from '../store/idb.js';
import { OAUTH, beginAuth, completeAuthIfReturning, getToken, clearToken } from '../sources/oauth.js';
import { READERS } from '../sources/drives.js';
import { mergeImportedNotes } from './notes.js';
import { pickAutoFile, listGithubRootCandidates, fetchGithubModifiedTime } from '../sources/autodetect.js';
import {
  $, S, App, Sheet, Art, isOwned, toast, norm, lsGet, lsSet, requestArt, paintOwned, renderStats,
  syncAlbums, summarizeDiff, onSheetCoverMiss, requestSynopsis,
} from '../main.js';

const kv = createKv();
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k.startsWith('on') ? n.addEventListener(k.slice(2), v) : k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  n.append(...kids);
  return n;
};
document.head.append(el('style', {}, `.x-dlg{background:var(--surface);color:var(--text);border:1px solid var(--stroke2);border-radius:16px;padding:20px;width:min(560px,94vw)}.x-dlg::backdrop{background:rgba(0,0,0,.55)}.x-dlg input:not([type=radio]),.x-dlg textarea,.x-dlg select{width:100%;box-sizing:border-box;background:var(--bg2);color:inherit;border:1px solid var(--stroke);border-radius:10px;padding:10px;font:inherit;min-height:44px}.x-dlg textarea{min-height:90px}.x-row{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap;align-items:center}.x-list{list-style:none;margin:8px 0 0;padding:0;max-height:50vh;overflow:auto}.x-list li{padding:11px 12px;border-radius:10px;cursor:pointer;min-height:44px;box-sizing:border-box}.x-list li[aria-selected=true]{background:var(--surface2)}.x-skip{max-height:110px;overflow:auto;font-size:12px;color:var(--text2)}#syncBtn[data-state=error]{color:#ff7a7a}#syncBtn[data-state=checking]{opacity:.6}@media (prefers-reduced-motion:no-preference){.x-dlg[open]{animation:xin .18s ease-out}}@keyframes xin{from{opacity:0;transform:translateY(8px)}}`));

const snapshot = () => ({ albums: S.albums, skipped: S.skipped, text: S.lastText, name: S.source, kind: S.sourceKind });
const restore = (p) => App.applyText(p.text, p.name, p.kind, { albums: p.albums, skipped: p.skipped });
const download = (name, text, type) => { const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
const readFiles = (files) => Promise.all([...files].map(async (f) => {
  if (f.size > MAX_BYTES) throw new Error(`${f.name} is larger than 8 MB`);
  return { name: f.name, text: await f.text() };
}));

/* ---------- import dialog ---------- */
let staged = null;
const msg = el('p', { role: 'status', 'aria-live': 'polite', style: 'color:var(--text2);margin:6px 0' });
const mapBox = el('div'), skipBox = el('ul', { class: 'x-skip' });
const paste = el('textarea', { placeholder: 'Paste albums: "Artist - Title (Year)" per line, CSV, JSON or OPML', 'aria-label': 'Paste text' });
const urlIn = el('input', { type: 'url', placeholder: 'https://gist.github.com/… or a GitHub file link', 'aria-label': 'Import from URL' });
const fileIn = el('input', { type: 'file', multiple: '', accept: '.md,.markdown,.txt,.csv,.tsv,.json,.opml,.xml', 'aria-label': 'Choose files' });
const saveSrc = el('input', { type: 'checkbox', id: 'xSave' });
const minutes = el('input', { type: 'number', min: '0', max: '1440', value: lsGet('crate.cloud.min', '5'), 'aria-label': 'Auto-check minutes, 0 is off', style: 'width:90px' });
const radio = (v, t, on) => el('label', {}, el('input', { type: 'radio', name: 'xmode', value: v, ...(on ? { checked: '' } : {}) }), ' ' + t);
const commitBtn = el('button', { class: 'btn primary', type: 'button', disabled: '', onclick: commit }, 'Import');
let oauthCfg = {};
const provSel = el('select', { 'aria-label': 'Cloud provider' }, ...Object.entries(OAUTH).map(([id, p]) => el('option', { value: id }, p.label)), el('option', { value: '', disabled: '' }, 'Box, MEGA, iCloud Drive: not supported (see docs/DEVLOG.md)'));
const pathIn = el('input', { type: 'text', placeholder: 'Path or file name, e.g. /crate/albums.md', 'aria-label': 'File path in your cloud drive' });
const connectBtn = el('button', { class: 'btn', type: 'button', onclick: () => connectProvider(provSel.value, pathIn.value.trim()) }, 'Connect and sync');
const dlg = el('dialog', { class: 'x-dlg', 'aria-labelledby': 'xTitle' },
  el('h2', { id: 'xTitle' }, 'Import albums'),
  fileIn, el('div', { class: 'x-row' }, paste), el('div', { class: 'x-row' }, urlIn, el('button', { class: 'btn', type: 'button', onclick: () => loadUrl(urlIn.value) }, 'Load URL')),
  el('div', { class: 'x-row' }, provSel, pathIn, connectBtn),
  msg, mapBox, skipBox,
  el('div', { class: 'x-row' }, radio('merge', 'Merge', true), radio('replace', 'Replace')),
  el('div', { class: 'x-row' }, saveSrc, el('label', { for: 'xSave' }, 'Keep this URL as my source, check every'), minutes, ' min'),
  el('div', { class: 'x-row' }, commitBtn, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel')));
dlg.addEventListener('dragover', (e) => e.preventDefault());
dlg.addEventListener('drop', async (e) => { e.preventDefault(); try { stage(await readFiles(e.dataTransfer.files)); } catch (err) { msg.textContent = err.message; } });
fileIn.addEventListener('change', async () => { try { stage(await readFiles(fileIn.files)); } catch (err) { msg.textContent = err.message; } });
let pasteT; paste.addEventListener('input', () => { clearTimeout(pasteT); pasteT = setTimeout(() => paste.value.trim() && stage([{ name: 'pasted.txt', text: paste.value }]), 250); });
document.body.append(dlg);

function stage(files, mapping) {
  const parts = [], errors = [];
  for (const f of files) { try { parts.push({ f, r: importText(f.name, f.text, { mapping }) }); } catch (e) { errors.push(`${f.name}: ${e.message}`); } }
  let albums = [], skipped = [];
  for (const { r } of parts) { albums = applyImport(albums, r.albums, 'merge').albums; skipped = skipped.concat(r.skipped); }
  staged = { files, albums, skipped, url: null };
  const inferred = albums.filter((a) => a.inferred).length;
  msg.textContent = errors.join('; ') || `${parts.map((p) => p.r.format).join(', ')} · ${albums.length} albums · ${skipped.length} skipped · ${inferred} genres inferred`;
  skipBox.replaceChildren(...skipped.slice(0, 50).map((s) => el('li', {}, `${s.n ? 'Line ' + s.n + ': ' : ''}${s.text.slice(0, 80)} (${s.reason})`)));
  mapBox.replaceChildren();
  if (parts.length === 1 && parts[0].r.headers) {
    const { headers, mapping: used } = parts[0].r, sels = {};
    for (const key of ['artist', 'title', 'year', 'genre', 'owned']) {
      const sel = el('select', { 'aria-label': `Column for ${key}` }, el('option', { value: '' }, '(none)'), ...headers.map((h, i) => el('option', { value: String(i), ...(used[key] === i ? { selected: '' } : {}) }, h)));
      sel.addEventListener('change', () => stage(files, Object.fromEntries(Object.entries(sels).filter(([, s]) => s.value !== '').map(([k, s]) => [k, +s.value]))));
      sels[key] = sel;
      mapBox.append(el('div', { class: 'x-row' }, el('span', { style: 'width:70px' }, key), sel));
    }
  }
  commitBtn.disabled = !albums.length;
}

async function loadUrl(raw) {
  const n = normalizeShareUrl(raw);
  if (n.error) return void (msg.textContent = n.error);
  try {
    const res = await fetch(n.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('remote file larger than 8 MB');
    stage([{ name: new URL(n.url).pathname.split('/').pop() || 'remote.md', text }]);
    staged.url = n.url;
    if (n.hint) msg.textContent += ` · ${n.hint}`;
  } catch (e) {
    msg.textContent = `${e.message}. ${n.hint || (e instanceof TypeError ? 'The host blocked the read (CORS) or is unreachable. Use a GitHub Gist or a raw GitHub file.' : '')}`;
  }
}

function commit() {
  const mode = dlg.querySelector('input[name=xmode]:checked').value, prev = snapshot();
  const out = applyImport(S.albums, staged.albums, mode), name = staged.files.map((f) => f.name).join(', ').slice(0, 60);
  App.applyText(staged.files[0].text, name, 'import', { albums: out.albums, skipped: staged.skipped, hadHeadings: true });
  mergeImportedNotes(staged.albums);
  toast(`Imported +${out.added}${mode === 'replace' ? `, replaced ${out.removed}` : ''}`, { label: 'Undo', fn: () => restore(prev) });
  lsSet('crate.cloud.min', String(Math.max(0, +minutes.value || 0)));
  dlg.close();
  if (saveSrc.checked && staged.url) startCloud(staged.url);
}
const openImport = () => { staged = null; msg.textContent = ''; mapBox.replaceChildren(); skipBox.replaceChildren(); paste.value = ''; commitBtn.disabled = true; dlg.showModal(); };

/**
 * File auto-fetch (brief item 6), UI half. The pure "which file" logic (`pickAutoFile`) and the GitHub
 * listing helpers were built and unit-tested in Slice 10 but left unwired into `boot()` on purpose — see
 * docs/DEVLOG.md Slice 10/this-slice for why touching boot()'s cloud-source race blind would have been reckless.
 * This stays true to that: it is an explicit, opt-in command-palette action, never part of the boot
 * sequence, and it reuses `openImport`'s dialog and `stage()`/`loadUrl` plumbing for the actual load — the
 * exact same path "Load a different file…" already uses — so it is architecturally incapable of racing
 * `boot()`'s own fetch; by the time a user can even open the command palette, boot() has long since settled.
 *
 * Two source kinds:
 * - A local folder, via the File System Access API's `showDirectoryPicker()` — Chromium/Edge only (not
 *   Firefox or Safari as of this writing), and only over https or http://localhost (confirmed: this app's
 *   own dev instructions already say to serve over localhost, so that constraint is already met whenever
 *   this feature would be reachable at all). This is the only standards-track way a static page can get a
 *   real last-modified timestamp per file without a server-side listing endpoint (see autodetect.js's
 *   header comment) — `getFile().lastModified` is exposed once the user grants folder access via a real
 *   user gesture, which this command supplies by construction (it only runs from a click).
 * - A GitHub repo root, read from `crate.ai` config or prompted for inline; uses `listGithubRootCandidates`
 *   then, capped at 8 files, `fetchGithubModifiedTime` per candidate (bounded against GitHub's
 *   unauthenticated 60/hour limit, matching autodetect.js's own caution).
 * In both cases `pickAutoFile` picks the best candidate; the rest are offered in a small list so the user
 * isn't stuck with a wrong guess.
 */
async function runAutoDetect() {
  if (!('showDirectoryPicker' in window)) return void autoDetectGithub();
  let dirHandle;
  try { dirHandle = await window.showDirectoryPicker({ mode: 'read' }); }
  catch (e) { if (e.name === 'AbortError') return; return toast('Could not open a folder: ' + e.message); }
  const entries = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file' || !/\.(md|markdown|txt)$/i.test(name)) continue;
      const file = await handle.getFile();
      entries.push({ name, modifiedAt: file.lastModified, handle });
    }
  } catch (e) { return toast('Could not read that folder: ' + e.message); }
  const { all, best } = pickAutoFile(entries);
  if (!all.length) return toast('No .md or .txt files found in that folder');
  await offerAutoDetectPick(all, best, async (entry) => {
    const file = await entry.handle.getFile();
    stage([{ name: entry.name, text: await file.text() }]);
  });
}
async function autoDetectGithub() {
  const cfg = (() => { try { return JSON.parse(lsGet('crate.autodetect.gh', '{}')) || {}; } catch { return {}; } })();
  const raw = prompt('GitHub repo to scan (owner/repo). Folder picking needs Chrome/Edge; this browser doesn\'t support it, so GitHub is the fallback.', cfg.repo || '');
  if (!raw) return;
  const m = raw.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return toast('Expected the form owner/repo');
  const [, owner, repo] = m;
  lsSet('crate.autodetect.gh', JSON.stringify({ repo: `${owner}/${repo}` }));
  toast('Scanning ' + owner + '/' + repo + '…');
  let items;
  try { items = await listGithubRootCandidates(owner, repo, undefined, undefined); }
  catch (e) { return toast('GitHub scan failed: ' + e.message); }
  if (!items.length) return toast('No .md or .txt files in that repo\'s root');
  const capped = items.slice(0, 8);
  await Promise.all(capped.map(async (it) => {
    try { it.modifiedAt = await fetchGithubModifiedTime(owner, repo, it.path, undefined, undefined); }
    catch { it.modifiedAt = null; } // rate-limited or unreachable; pickAutoFile already treats null as "unknown", not an error
  }));
  const { all, best } = pickAutoFile(capped);
  await offerAutoDetectPick(all, best, async (entry) => {
    const res = await fetch(entry.downloadUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    stage([{ name: entry.name, text: await res.text() }]);
  });
}
/** Shared "here's the best pick, here are the rest" prompt for both auto-detect sources, reusing the
 * import dialog so the user still gets the normal preview/merge-or-replace/commit flow — auto-detect only
 * ever picks WHICH file, never skips the review step `stage()`/`commitBtn` already provide. */
async function offerAutoDetectPick(all, best, load) {
  openImport();
  msg.textContent = `Scanning… found ${all.length} candidate${all.length > 1 ? 's' : ''}.`;
  if (all.length > 1) {
    const list = all.map((e) => e.name).join(', ');
    msg.textContent += ` Loading the most recently modified (${best.name}). Others found: ${list}. Use "Load URL" or drop a file to pick a different one.`;
  }
  try { await load(best); } catch (e) { msg.textContent = 'Could not load ' + best.name + ': ' + e.message; }
}

/* ---------- cloud source ---------- */
let cloud = null, manual = false, sourceName = 'source';
const syncBtn = el('button', { class: 'icon-btn', id: 'syncBtn', hidden: '', 'aria-label': 'Source sync status', title: 'Source sync', onclick: () => { manual = true; cloud?.checkNow(); } }, '⟳');
const importBtn = el('button', { class: 'icon-btn', id: 'importBtn', title: 'Import albums', 'aria-label': 'Import albums', onclick: openImport }, '⤒');
$('#helpBtn').before(importBtn, syncBtn);

function onRemote(text, tag) {
  const name = sourceName;
  let r;
  try { r = importText(name, text); } catch (e) { return toast('Source rejected: ' + e.message); }
  if (!r.albums.length) return toast('Source has no albums; kept current list');
  const hadAlbums = S.albums.length > 0, prev = snapshot();
  mergeImportedNotes(r.albums);
  const diff = syncAlbums(r.albums, { name: name + (tag ? ` (${tag})` : ''), kind: 'cloud', text });
  if (hadAlbums && (diff.added.length || diff.removed.length || diff.changed.length)) {
    toast(`Source updated: ${summarizeDiff(diff)}`, { label: 'Undo', fn: () => restore(prev) });
  }
}

function startCloud(url, remember = true, read = null, label = '') {
  cloud?.stop();
  sourceName = label || new URL(url).pathname.split('/').pop() || 'source';
  if (remember) lsSet('crate.cloud', url);
  syncBtn.hidden = false;
  cloud = createCloudSource({
    url, read, kv, minutes: Number(lsGet('crate.cloud.min', '5')), onChange: onRemote,
    onState: (s) => {
      syncBtn.dataset.state = s.status;
      syncBtn.textContent = { checking: '⟳', ok: '●', offline: '○' }[s.status] ?? '!';
      syncBtn.title = `Source ${s.status}${s.lastSynced ? ' · synced ' + new Date(s.lastSynced).toLocaleTimeString() : ''}${s.message ? ' · ' + s.message : ''}`;
      if (manual && s.status !== 'checking') { manual = false; toast(s.status === 'ok' ? 'Source checked' : `Source ${s.status}: ${s.message}`); }
    },
  });
  cloud.cached().then((t) => { if (t && !S.albums.length) onRemote(t, 'cached'); }).finally(() => cloud.checkNow());
}

function startProvider(id, path) {
  const reader = async (validators, signal) => {
    const token = getToken(id);
    if (!token) throw new Error('not signed in, press Connect and sync');
    try { return await READERS[id](path, validators, signal, token); } catch (e) { if (e.auth) clearToken(id); throw e; }
  };
  lsSet('crate.cloud.provider', JSON.stringify({ id, path }));
  startCloud(`${id}:${path}`, false, reader, path.split('/').pop() || path);
}
function connectProvider(id, path) {
  if (!id || !path) return void (msg.textContent = 'Pick a provider and enter a file path or name');
  const clientId = oauthCfg[id]?.clientId;
  if (!clientId) return void (msg.textContent = `Missing oauth.${id}.clientId in config.json (register an app with ${OAUTH[id].label}; see README)`);
  lsSet('crate.cloud.min', String(Math.max(0, +minutes.value || 0)));
  if (getToken(id)) { startProvider(id, path); return void dlg.close(); }
  beginAuth(id, clientId, path).catch((e) => { msg.textContent = e.message; });
}

(async function initSource() {
  try { oauthCfg = (await (await fetch('config.json', { cache: 'no-store' })).json()).oauth ?? {}; } catch { /* no config */ }
  try {
    const back = await completeAuthIfReturning(oauthCfg);
    if (back) { startProvider(back.provider, back.path); return toast(`${OAUTH[back.provider].label} connected`); }
  } catch (e) { toast('Sign-in failed: ' + e.message); }
  try {
    const saved = JSON.parse(lsGet('crate.cloud.provider', 'null'));
    if (saved && !new URLSearchParams(location.search).get('src')) return startProvider(saved.id, saved.path);
  } catch { /* bad saved value */ }
  const q = new URLSearchParams(location.search).get('src');
  let url = q && /^https:/.test(q) ? q : lsGet('crate.cloud', '');
  if (!url) { try { url = (await (await fetch('config.json', { cache: 'no-store' })).json()).source || ''; } catch { /* no config */ } }
  const n = url && normalizeShareUrl(url);
  if (n?.url) startCloud(n.url, !q);
})();

/* ---------- ownership + export ---------- */
const persistOwn = () => lsSet('crate.own.v2', JSON.stringify(S.ownMap));
const repaintOwn = () => { S.albums.forEach(paintOwned); renderStats(); App.renderList(); };
const ownPicker = el('input', { type: 'file', accept: '.json', hidden: '', 'aria-label': 'Import ownership file' });
ownPicker.addEventListener('change', async () => {
  try {
    const own = ownershipFromJson((await readFiles(ownPicker.files))[0].text), prev = { ...S.ownMap };
    Object.assign(S.ownMap, own); persistOwn(); repaintOwn();
    toast(`Ownership imported (${Object.keys(own).length})`, { label: 'Undo', fn: () => { S.ownMap = prev; persistOwn(); repaintOwn(); } });
  } catch (e) { toast('Ownership import failed: ' + e.message); }
  ownPicker.value = '';
});
document.body.append(ownPicker);

/* ---------- command palette ---------- */
export const ACTIONS = [
  ['Import albums…', openImport],
  ['Export as .md', () => download('crate.md', toMarkdown(S.albums, isOwned), 'text/markdown')],
  ['Export as .csv', () => download('crate.csv', toCsv(S.albums, isOwned), 'text/csv')],
  ['Export as .json', () => download('crate.json', toJson(S.albums, isOwned), 'application/json')],
  ['Export ownership', () => download('crate-ownership.json', ownershipToJson(S.ownMap), 'application/json')],
  ['Import ownership…', () => ownPicker.click()],
  ['Check source now', () => { manual = true; cloud ? cloud.checkNow() : toast('No source URL saved'); }],
  ['Load a different file…', openImport],
  ['Scan for a file to auto-load…', runAutoDetect],
  ['Remove loaded file / start over', () => {
    if (!S.albums.length && !cloud) return toast('Nothing loaded yet');
    cloud?.stop(); cloud = null; syncBtn.hidden = true;
    lsSet('crate.cloud', ''); lsSet('crate.cloud.provider', ''); lsSet('crate.md.v1', '');
    S.albums = []; S.byId = new Map(); S.skipped = []; S.source = ''; S.sourceKind = ''; S.lastText = '';
    S.sections = []; S.decades = []; S.hasUnknownYear = false;
    ['exportBtn', 'retryBtn', 'surpriseBtn', 'collapseBtn'].forEach((id) => { $('#' + id).disabled = true; });
    App.renderList(); renderStats();
    $('#footCount').textContent = ''; $('#subcount').textContent = 'No albums loaded';
    toast('Removed. Import a new list or load a file to start over.');
    openImport();
  }],
  ['Toggle theme', () => $('#themeToggle').click()],
  ['Open AI settings', () => $('#aiBtn').click()],
  ['Keyboard shortcuts', () => $('#helpBtn').click()],
].map(([label, run]) => ({ label, run }));

const palInput = el('input', { role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'xPalList', 'aria-label': 'Command palette', placeholder: 'Search albums, genres, actions…', autocomplete: 'off' });
const palList = el('ul', { class: 'x-list', id: 'xPalList', role: 'listbox' });
const pal = el('dialog', { class: 'x-dlg', 'aria-label': 'Command palette' }, palInput, palList);
document.body.append(pal);
let palItems = [], palSel = 0;
function palRender() {
  const q = norm(palInput.value);
  const genres = q ? S.sections.filter((s) => norm(s).includes(q)).slice(0, 5).map((s) => ({ label: 'Genre: ' + s, run: () => { S.section = s; $('#genreSel').value = s; App.renderList(); } })) : [];
  const albums = q.length > 1 ? S.albums.filter((a) => a.hay?.includes(q)).slice(0, 8).map((a) => ({ label: `${a.artist} - ${a.title}`, run: () => Sheet.open(a) })) : [];
  palItems = [...ACTIONS.filter((a) => !q || norm(a.label).includes(q)), ...genres, ...albums];
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  palList.replaceChildren(...palItems.map((it, i) => el('li', { role: 'option', 'aria-selected': String(i === palSel), onclick: () => run(i) }, it.label)));
  palList.children[palSel]?.scrollIntoView({ block: 'nearest' });
}
function run(i) { const it = palItems[i]; pal.close(); it?.run(); }
palInput.addEventListener('input', () => { palSel = 0; palRender(); });
palInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % palItems.length; palRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(palSel); }
});
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palInput.value = ''; palSel = 0; palRender(); if (!pal.open) pal.showModal(); palInput.focus(); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

/* ---------- covers: per-album control, status, undo ---------- */
const HOST_OK = /^(?:[^.]+\.)*(?:mzstatic\.com|dzcdn\.net|coverartarchive\.org|archive\.org|wikimedia\.org)$/;
let curAlbum = null;
const postersFor = (id) => [...document.querySelectorAll('.poster')].filter((p) => p._album?.id === id);
export function refreshPosters(id) {
  for (const p of postersFor(id)) {
    p.querySelectorAll('img.art').forEach((i) => i.remove());
    p._art = null;
    if (p._cb) { Art.unwant(id, p._cb); p._cb = null; }
    requestArt(p, p.closest('.sheet') !== null);
  }
}
async function changeCover(a, action, message = 'Cover updated') {
  const prev = await Art.peek(a.id);
  await action();
  refreshPosters(a.id);
  toast(message, { label: 'Undo', fn: async () => { await Art.retry(a.id); if (prev) Art.restoreEntries([prev]); refreshPosters(a.id); } });
}
const coverPicker = el('input', { type: 'file', accept: 'image/*', hidden: '', 'aria-label': 'Choose cover image' });
document.body.append(coverPicker);
coverPicker.addEventListener('change', () => {
  const f = coverPicker.files[0], a = curAlbum;
  coverPicker.value = '';
  if (!f || !a) return;
  if (!f.type.startsWith('image/') || f.size > MAX_BYTES) return toast('Choose an image file under 8 MB');
  changeCover(a, () => Art.setUser(a.id, { blob: f }), 'Your cover is set');
});
function coverFromUrl() {
  const a = curAlbum, raw = a && prompt('Image URL (https). The page security policy only allows covers from Apple, Deezer, Cover Art Archive, archive.org and Wikimedia; for any other host, download the image and use "Use my cover".');
  if (!raw) return;
  let u;
  try { u = new URL(raw.trim()); } catch { return toast('Not a valid URL'); }
  if (u.protocol !== 'https:' || !HOST_OK.test(u.hostname)) return toast('Host not allowed by the security policy. Download the image and use "Use my cover".');
  changeCover(a, () => Art.setUser(a.id, { url: u.href }), 'Your cover is set');
}
/**
 * Poster-choice modal (brief item 3c). "Change poster" reuses the same `#posterChoice` dialog whether it
 * was reached manually from the sheet or (not wired automatically here — see docs/DEVLOG.md Slice 10 for why)
 * after an exhausted provider chain: both paths call `openPosterChoice(album)`, which reads whatever
 * near-miss candidates the cover service already collected during its last lookup for that album
 * (`Art.nearMisses`, populated by `js/covers/service.js`'s `resolve()`), deduplicated by URL and capped at
 * 4 there. Picking one pins it through the exact same `Art.setUser`/Undo contract as "Use my cover" and
 * "Cover from URL" above — no parallel pinning mechanism.
 */
const pcDlg = $('#posterChoice'), pcGrid = $('#posterChoiceGrid'), pcNote = $('#posterChoiceNote');
function openPosterChoice(a) {
  curAlbum = a;
  const cands = Art.nearMisses(a.id);
  pcGrid.replaceChildren();
  if (!cands.length) {
    pcNote.textContent = `No near-miss candidates were kept from the last lookup for "${a.title}". Try "Retry cover" first, or use your own image below.`;
  } else {
    pcNote.textContent = 'None of the automatic matches were confident enough. Pick the closest one, or use your own image.';
    for (const c of cands) {
      const btn = el('button', { class: 'poster-choice-opt', type: 'button', title: `${c.title || a.title}${c.artist ? ' — ' + c.artist : ''} (via ${c.provider})`, 'aria-label': `Use this cover: ${c.title || a.title}`,
        onclick: () => { pcDlg.close(); changeCover(a, () => Art.setUser(a.id, { url: c.url }), 'Cover set from your pick'); } },
        el('img', { src: c.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
      pcGrid.append(btn);
    }
  }
  pcDlg.showModal();
}
$('#posterChoiceCancel').addEventListener('click', () => pcDlg.close());
$('#posterChoiceOwn').addEventListener('click', () => { pcDlg.close(); if (curAlbum) coverPicker.click(); });
pcDlg.addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/** Inline miss row (brief item 3c, auto-trigger half). js/main.js's openSheetImpl fires this only when the
 * sheet's own eager cover lookup settles with no url, scoped to the single album the user has the sheet
 * open for — never for grid posters, never a blocking <dialog> popped mid-scroll (see the doc comment on
 * `onSheetCoverMiss` in js/main.js for the full reasoning this slice carries forward from Slice 10's
 * correct rejection of the "pop on every miss" design). Clicking "Choose one…" opens the exact same
 * #posterChoice dialog "Change poster" does — one modal, two entry points, no parallel UI. */
onSheetCoverMiss((a) => { curAlbum = a; });
$('#sheetCoverMissBtn')?.addEventListener('click', () => { if (curAlbum) openPosterChoice(curAlbum); });

document.querySelector('#sheetActionsUtility').append(
  el('button', { class: 'btn ghost', type: 'button', onclick: () => curAlbum && coverPicker.click() }, 'Use my cover'),
  el('button', { class: 'btn ghost', type: 'button', onclick: coverFromUrl }, 'Cover from URL'),
  el('button', { class: 'btn ghost', type: 'button', onclick: () => { const a = curAlbum; if (a) changeCover(a, () => Art.retry(a.id), 'Retrying cover'); } }, 'Retry cover'),
  el('button', { class: 'btn ghost', type: 'button', onclick: requestSynopsis }, 'Synopsis'),
  el('button', { class: 'btn ghost', type: 'button', onclick: () => curAlbum && openPosterChoice(curAlbum) }, 'Change poster'));
{
  const original = Sheet.open;
  Sheet.open = (a, why) => { curAlbum = a; return original(a, why); };
}

const statBody = el('pre', { style: 'font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;margin:8px 0' });
const statDlg = el('dialog', { class: 'x-dlg', 'aria-label': 'Cover status' }, el('h2', {}, 'Cover status'), statBody,
  el('div', { class: 'x-row' }, el('button', { class: 'btn', type: 'button', onclick: () => statDlg.close() }, 'Close')));
document.body.append(statDlg);
let statTimer;
const statRender = () => {
  const s = Art.snapshot();
  statBody.textContent = s ? `queued ${s.queued} · active ${s.active}\n` + Object.entries(s.stats).map(([n, x]) => `${n.padEnd(12)} hits ${x.hits} · no match ${x.misses} · errors ${x.errors}`).join('\n') : 'No lookups yet.';
};
statDlg.addEventListener('close', () => clearInterval(statTimer));
const openStatus = () => { statRender(); statTimer = setInterval(statRender, 1000); statDlg.showModal(); };

async function perfProbe() {
  toast('Scrolling the list for 10 s…');
  const longTasks = [], frames = [];
  const observer = new PerformanceObserver((l) => longTasks.push(...l.getEntries()));
  try { observer.observe({ type: 'longtask' }); } catch { /* unsupported */ }
  const heap0 = performance.memory?.usedJSHeapSize, max = document.documentElement.scrollHeight - innerHeight, t0 = performance.now();
  let last = t0;
  await new Promise((done) => {
    const step = (t) => { frames.push(t - last); last = t; const p = (t - t0) / 10000; scrollTo(0, max * (p < 0.5 ? p * 2 : 2 - p * 2)); p < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  });
  observer.disconnect();
  frames.sort((x, y) => x - y);
  const heap = performance.memory ? `, heap ${((performance.memory.usedJSHeapSize - heap0) / 1048576).toFixed(1)} MB` : '';
  const report = `frames ${frames.length}, p95 ${frames[Math.floor(frames.length * 0.95)].toFixed(1)} ms, long tasks ${longTasks.length} (max ${Math.max(0, ...longTasks.map((l) => l.duration)).toFixed(0)} ms)${heap}, albums ${S.albums.length}`;
  console.log('[crate perf]', report);
  statBody.textContent = report; statDlg.showModal();
}

const SAMPLE = '## ROCK\n- Pixies - Doolittle (1989)\n- Radiohead - OK Computer (1997)\n- Weezer - Weezer (1994)\n- The Beatles - Abbey Road (1969)\n## METAL\n- Black Sabbath - Paranoid (1970)\n- Slayer - Reign in Blood (1986)\n- Metallica - Master of Puppets (1986)\n## JAZZ\n- Miles Davis - Kind of Blue (1959)\n- John Coltrane - A Love Supreme (1965)\n- Dave Brubeck - Time Out (1959)\n';
const TIPS = ['Tap an album for details. Use the arrows in the detail sheet to move between albums.', 'Press Ctrl/Cmd+K for search, import, export, theme and cover tools. The ? button lists shortcuts.', 'Your list and ownership stay in this browser. Only cover lookups leave it, and AI picks send data only when you press the button.'];
const welcome = el('dialog', { class: 'x-dlg', 'aria-labelledby': 'xWelcome' }, el('h2', { id: 'xWelcome' }, 'Welcome to Crate'),
  el('ol', {}, ...TIPS.map((t) => el('li', { style: 'margin:8px 0' }, t))),
  el('div', { class: 'x-row' },
    el('button', { class: 'btn primary', type: 'button', onclick: () => { welcome.close(); openImport(); } }, 'Import a list or URL'),
    el('button', { class: 'btn', type: 'button', onclick: () => { welcome.close(); App.applyText(SAMPLE, 'sample.md', 'sample'); } }, 'Load sample data'),
    el('button', { class: 'btn', type: 'button', onclick: () => welcome.close() }, 'Close')));
welcome.addEventListener('close', () => lsSet('crate.welcomed', '1'));
document.body.append(welcome);
setTimeout(() => { if (!S.albums.length && !lsGet('crate.welcomed', '') && !lsGet('crate.cloud', '') && !lsGet('crate.cloud.provider', '')) welcome.showModal(); }, 2500);

document.head.append(el('style', {}, '.card{content-visibility:auto;contain-intrinsic-size:auto 280px}'));

ACTIONS.push(
  { label: 'Cover status', run: openStatus },
  { label: 'Clear all cover misses', run: () => Art.retryMissing().then((es) => toast(`Cleared ${es.length} cached misses`, { label: 'Undo', fn: () => Art.restoreEntries(es) })) },
  { label: 'Run scroll performance probe', run: perfProbe },
  { label: 'Show tips', run: () => welcome.showModal() },
);
