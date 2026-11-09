/**
 * Freeform single-album input — for the "What to listen to today" seed box (js/main.js), not the bulk
 * crate importer (js/parser/text.js's parseEntry, which already has its own strict, tested grammar for
 * checklist lines). A person typing one album by hand uses whatever order and separator they reach for
 * first, so this tries several interpretations and lets the caller pick the one that actually matches
 * something (see resolveFreeform) instead of committing to one guess up front.
 *
 * Case: every comparison goes through matcher.js's normalize(), which already lowercases, strips accents
 * and drops a leading "the" — so "THE BEATLES - abbey road" and "the beatles - Abbey Road" resolve
 * identically with no extra work here.
 */
import { normalize, bestMatch } from '../covers/matcher.js';

const YEAR_RE = /\s*[([]\s*(\d{4})\s*[)\]]\s*$/;
const SEPARATORS = [' - ', ' – ', ' — ', ' : ', ': ', ' // ', ' / '];
const BY_RE = /^(.+?)\s+\bby\b\s+(.+)$/i;

const stripQuotes = (s) => s.replace(/^["'“‘]+|["'”’]+$/g, '').trim();

/** "abbey road" -> "Abbey Road". Only applied when the whole string has no internal case variation at
 * all (all-lower or all-upper), so a person's own mixed-case styling (e.g. "OK Computer") is never
 * second-guessed. */
function smartCase(s) {
  if (!s || /[a-z]/.test(s) === /[A-Z]/.test(s)) return s; // mixed case, or no letters: leave alone
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Returns every plausible {artist, title, year} reading of one hand-typed line, most-likely first.
 * Never throws; a line with no recognisable separator still comes back as a single title-only guess
 * (artist: null) so the caller can fall back to an AI free-text prompt instead of failing outright.
 */
export function parseFreeformQuery(raw) {
  let s = stripQuotes(String(raw ?? '').trim());
  if (!s) return [];
  let year = null;
  const ym = s.match(YEAR_RE);
  if (ym) { year = +ym[1]; s = s.slice(0, ym.index).trim(); }

  const out = [];
  const add = (artist, title) => { artist = smartCase(artist?.trim()); title = smartCase(title?.trim()); if (artist && title) out.push({ artist, title, year }); };

  const by = s.match(BY_RE);
  if (by) add(by[2], by[1]); // "Title by Artist"

  for (const sep of SEPARATORS) {
    const i = s.indexOf(sep);
    if (i < 1) continue;
    const left = s.slice(0, i), right = s.slice(i + sep.length);
    add(left, right); // "Artist - Title" (far more common, tried first)
    add(right, left); // "Title - Artist"
    break; // first separator found wins; trying every separator on the same string invites nonsense splits
  }

  if (!out.length) out.push({ artist: null, title: smartCase(s), year }); // no separator: title-only guess
  return out;
}

/**
 * Resolves a hand-typed line against the loaded crate using the same scorer cover-art lookup trusts
 * (js/covers/matcher.js), so "found in your crate" means the same thing here as everywhere else in the
 * app. Tries every reading from parseFreeformQuery and keeps the best-scoring hit across all of them,
 * which is what actually disambiguates "Artist - Title" from a line that's really "Title - Artist".
 * Returns { album, query } (album is null when nothing in the crate scores above bestMatch's threshold —
 * the caller can still use `query` as a seed for a free-text AI prompt or for ARTIST_GENRE inference).
 */
export function resolveFreeform(raw, albums) {
  const candidates = parseFreeformQuery(raw);
  if (!candidates.length) return { album: null, query: null };
  let best = null, bestQuery = candidates[0];
  for (const q of candidates) {
    if (!q.artist) continue; // bestMatch needs an artist guess to score against; title-only has none
    const m = bestMatch(q, albums);
    if (m && (!best || m.score > best.score)) { best = m; bestQuery = q; }
  }
  return { album: best, query: bestQuery };
}

export const _test = { normalize };
