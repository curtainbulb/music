import { parseAlbums, parseEntry, finalize, cleanHeading } from './text.js';

export const MAX_BYTES = 8 * 1024 * 1024;
const ALIASES = { artist: ['artist', 'band', 'performer'], title: ['title', 'album', 'name'], year: ['year', 'released', 'release year'],
  genre: ['genre', 'section', 'category'], owned: ['owned', 'own', 'have', 'collected'], notes: ['notes', 'note', 'comment'] };
const TRUE = /^(?:1|x|y|yes|true|owned|✓)$/i;

export function detectFormat(name, text) {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'opml' || ext === 'xml') return 'opml';
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv') return 'tsv';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'md';
  const head = text.replace(/^\uFEFF/, '').trimStart();
  if (/^[\[{]/.test(head)) return 'json';
  if (/^<(\?xml|opml)/i.test(head)) return 'opml';
  const first = head.split(/\r?\n/, 1)[0];
  if (first.includes('\t') && !/ - /.test(first)) return 'tsv';
  if ((first.match(/,/g) || []).length >= 2 && !/ - /.test(first)) return 'csv';
  return 'md';
}

/** RFC 4180 style: quoted fields, doubled quotes, newlines inside quotes, BOM. */
export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export function guessMapping(headers) {
  const lower = headers.map((h) => h.trim().toLowerCase()), mapping = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const idx = lower.findIndex((h) => names.includes(h));
    if (idx >= 0) mapping[key] = idx;
  }
  return mapping;
}

function rowsFromTable(table, mapping) {
  const rows = [], skipped = [];
  table.slice(1).forEach((cells, i) => {
    const get = (k) => (mapping[k] === undefined ? '' : String(cells[mapping[k]] ?? '').trim());
    const artist = get('artist'), title = get('title'), year = parseInt(get('year'), 10);
    if (!artist || !title) { skipped.push({ n: i + 2, text: cells.map(String).join(' | '), reason: 'missing artist or title' }); return; }
    const genre = get('genre');
    rows.push({ artist, title, year: year >= 1900 && year <= 2100 ? year : null, section: genre ? cleanHeading(genre) : null,
      sub: null, owned: mapping.owned === undefined ? null : TRUE.test(get('owned')), notes: get('notes') });
  });
  return { rows, skipped };
}

/** Shared by CSV/TSV (after delimiter parsing) and .xlsx (sheet already comes back as rows of cells). */
export function tableToAlbums(table, mapping, delimiterForError = ',') {
  if (!table.length) return { albums: [], skipped: [], headers: [], mapping: {} };
  const m = mapping ?? guessMapping(table[0]);
  if (m.artist === undefined || m.title === undefined) return { albums: [], skipped: [{ n: 1, text: table[0].join(delimiterForError), reason: 'no artist/title columns found' }], headers: table[0], mapping: m };
  const { rows, skipped } = rowsFromTable(table, m);
  const out = finalize(rows, skipped, rows.some((r) => r.section));
  return { ...out, headers: table[0], mapping: m };
}

export function parseTable(text, delimiter, mapping) {
  return tableToAlbums(parseDelimited(text, delimiter), mapping, delimiter);
}

export function parseJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { albums: [], skipped: [{ n: 0, text: '', reason: `invalid JSON: ${e.message}` }], hadHeadings: false }; }
  const items = [];
  if (Array.isArray(data)) data.forEach((o) => items.push([null, o]));
  else if (Array.isArray(data?.sections)) data.sections.forEach((sec) => (sec.albums ?? []).forEach((o) => items.push([sec.name ?? sec.title ?? null, o])));
  const rows = [], skipped = [];
  items.forEach(([sec, o], i) => {
    const artist = String(o?.artist ?? '').trim(), title = String(o?.title ?? '').trim(), year = parseInt(o?.year, 10);
    if (!artist || !title) { skipped.push({ n: i + 1, text: JSON.stringify(o).slice(0, 80), reason: 'missing artist or title' }); return; }
    const genre = sec ?? o.genre ?? o.section;
    rows.push({ artist, title, year: year >= 1900 && year <= 2100 ? year : null, section: genre ? cleanHeading(String(genre)) : null,
      sub: null, owned: typeof o.owned === 'boolean' ? o.owned : null, notes: String(o.notes ?? '') });
  });
  return finalize(rows, skipped, rows.some((r) => r.section));
}

const decodeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e]);

/** Token scan instead of DOMParser so it also runs in Node. A parent outline is a section; a leaf is an album line. */
export function parseOpml(text) {
  const rows = [], skipped = [], stack = [];
  const tagRe = /<(\/?)outline\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    if (m[1]) { stack.pop(); continue; }
    const label = decodeXml(/\btext="([^"]*)"/.exec(m[2])?.[1] ?? /\btitle="([^"]*)"/.exec(m[2])?.[1] ?? '');
    if (!m[3]) { stack.push(cleanHeading(label)); continue; }
    const entry = parseEntry(label);
    if (entry) rows.push({ ...entry, section: stack[stack.length - 1] ?? null });
    else skipped.push({ n: 0, text: label, reason: 'unrecognised outline' });
  }
  return finalize(rows, skipped, rows.some((r) => r.section));
}

/** Entry point. Throws on oversize input. Returns {format, albums, skipped, hadHeadings, headers?, mapping?}. */
export function importText(name, text, { delimiter, mapping } = {}) {
  if (text.length > MAX_BYTES) throw new Error('file larger than 8 MB');
  const format = detectFormat(name, text);
  if (format === 'xlsx') throw new Error('.xlsx is a binary format; read it with js/parser/xlsx.js, not importText');
  if (format === 'json') return { format, ...parseJson(text) };
  if (format === 'opml') return { format, ...parseOpml(text) };
  if (format === 'csv' || format === 'tsv') return { format, ...parseTable(text, delimiter ?? (format === 'tsv' ? '\t' : ','), mapping) };
  return { format: 'md', ...parseAlbums(text) };
}

/** Merge or replace. Merge keeps existing albums, adds unseen ids, never overwrites ownership (stored separately by id). */
export function applyImport(existing, incoming, mode) {
  if (mode === 'replace') return { albums: incoming, added: incoming.length, removed: existing.length };
  const have = new Set(existing.map((a) => a.id)), fresh = incoming.filter((a) => !have.has(a.id));
  return { albums: [...existing, ...fresh], added: fresh.length, removed: 0 };
}
