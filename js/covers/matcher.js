const EDITION = /\b(?:remaster(?:ed)?(?: \d{4})?|deluxe|expanded|mono|stereo|anniversary|bonus|edition|version|reissue)\b/g;
// Non-global twin of EDITION for one-shot .test() calls elsewhere in this file — a global regex's .test()
// keeps lastIndex state across calls, which would make repeated calls alternate true/false on the same input.
const EDITION_TEST = new RegExp(EDITION.source, 'i');
const COMPILATION = /\b(?:live|greatest hits|best of|anthology|collection|compilation|unplugged|sessions)\b/;

export const normalize = (s) =>
  String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');

/**
 * Dual-title poster parsing (product brief item 3). Some album titles carry both a foreign-script and a
 * Latin/English title, e.g. "さよならポニーテール / Goodbye Ponytail" or "Sayonara Ponytail (Goodbye Ponytail)".
 * Concatenating both halves into one query string produces a malformed search that matches nothing on any
 * provider, so this splits the title into an ordered array of candidate titles to try one at a time,
 * English/Latin-script candidate first (providers are far more likely to index the Latin title), foreign
 * title as a fallback. A plain title with no such pattern returns a single-element array unchanged, so
 * every existing call site keeps working by just looping over the (usually length-1) result.
 */
const LATIN_RE = /[A-Za-z]/;
const isLatinish = (s) => { const letters = s.replace(/[^\p{L}]/gu, ''); return !letters || LATIN_RE.test(letters[0]) || [...letters].filter((c) => LATIN_RE.test(c)).length >= letters.length / 2; };
export function splitDualTitle(title) {
  const raw = String(title ?? '').trim();
  if (!raw) return [raw];
  let a, b;
  const slash = raw.split(/\s*\/\s*/);
  if (slash.length === 2 && slash[0] && slash[1]) { [a, b] = slash; }
  else {
    const m = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(raw);
    // Only treat "Title (Other Title)" as a dual title when the parenthetical isn't an edition/qualifier
    // tag ("Remastered", "Deluxe Edition", a bare year, ...) — those are the existing cleanTitle() job and
    // splitting them would wrongly turn "Kind of Blue (Legacy Edition)" into two bogus title candidates.
    if (m && m[1].trim() && m[2].trim() && !EDITION_TEST.test(m[2]) && !/^\d{4}$/.test(m[2].trim())) { [a, b] = [m[1].trim(), m[2].trim()]; }
  }
  if (a == null) return [raw];
  // Order English/Latin-script candidate first, foreign-script fallback second. If both (or neither) look
  // Latin, keep the original left-to-right order rather than guessing further.
  const aLatin = isLatinish(a), bLatin = isLatinish(b);
  const ordered = (!aLatin && bLatin) ? [b, a] : [a, b];
  return ordered;
}

export function cleanTitle(title) {
  const stripped = normalize(String(title).replace(/[(\[][^)\]]*[)\]]/g, ' '))
    .replace(EDITION, ' ').replace(/\s+/g, ' ').trim();
  return stripped || normalize(title);
}

function editRatio(a, b) {
  if (a === b) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

function tokenDice(a, b) {
  const left = new Set(a.split(' ')), right = new Set(b.split(' '));
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return (2 * shared) / (left.size + right.size);
}

export const similarity = (a, b) => (a && b ? 0.5 * tokenDice(a, b) + 0.5 * editRatio(a, b) : 0);

export function scoreCandidate(album, cand) {
  const title = similarity(cleanTitle(album.title), cleanTitle(cand.title));
  const artist = similarity(normalize(album.artist), normalize(cand.artist));
  const yearGap = album.year && cand.year ? Math.abs(album.year - cand.year) : null;
  const year = yearGap === null ? 0.5 : Math.max(0, 1 - yearGap / 10);
  let score = 0.45 * title + 0.4 * artist + 0.15 * year;
  const wantsCompilation = COMPILATION.test(String(album.title).toLowerCase());
  if (!wantsCompilation && COMPILATION.test(String(cand.title).toLowerCase())) score -= 0.25;
  return { score, title, artist };
}

/** Candidates need title and artist similarity >= 0.6 on their own, so year and bonus terms cannot rescue a wrong album. */
export function bestMatch(album, cands, threshold = 0.72) {
  let best = null;
  for (const cand of cands) {
    const s = scoreCandidate(album, cand);
    if (s.title < 0.6 || s.artist < 0.6 || s.score < threshold) continue;
    if (!best || s.score > best.score) best = { ...cand, score: s.score };
  }
  return best;
}
