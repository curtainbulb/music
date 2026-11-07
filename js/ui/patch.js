/**
 * Pure diff between two album lists, keyed by album id (artist|title|year, normalized — see parser/text.js).
 * Used by the cloud sync path to (a) show the "Review" dialog with exactly what changed and (b) patch the
 * DOM incrementally instead of tearing down and rebuilding every card. No DOM access here, so it is
 * straightforward to unit test under Node; the DOM-touching half lives in applyPatchToDom() below.
 */
const FIELDS = ['artist', 'title', 'year', 'section', 'sub', 'notes'];

export function diffAlbums(oldAlbums, newAlbums) {
  const oldById = new Map(oldAlbums.map((a) => [a.id, a]));
  const newById = new Map(newAlbums.map((a) => [a.id, a]));
  const added = [], removed = [], changed = [];
  for (const a of newAlbums) {
    const before = oldById.get(a.id);
    if (!before) { added.push(a); continue; }
    const fields = FIELDS.filter((f) => (before[f] ?? null) !== (a[f] ?? null));
    if (fields.length) changed.push({ id: a.id, before, after: a, fields });
  }
  for (const a of oldAlbums) if (!newById.has(a.id)) removed.push(a);
  return { added, removed, changed, unchanged: newAlbums.length - added.length - changed.length };
}

export const hasDiff = (d) => d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0;

export const summarize = (d) => `+${d.added.length}, -${d.removed.length}, ~${d.changed.length}`;

/**
 * Applies a diff to the app's live DOM/state without a full rebuild. `ctx` is the small set of app
 * internals this needs (passed in rather than imported, so this stays a plain module with no dependency
 * on the global app — see js/main.js for the one call site). Preserves: cover cache (card/poster DOM
 * nodes for unaffected albums are never touched, so an already-loaded <img> stays exactly as it is),
 * ownership state (stored by id in S.ownMap, untouched here), collapsed sections, active filters,
 * scroll position (no node outside the changed set is removed or replaced) and multi-select (the caller
 * is responsible for dropping removed ids from its selection set; see js/ui/views.js).
 *
 * UNTESTED: exercises IntersectionObserver, requestArt/releaseArt and DOM mutation together; only
 * reachable with a live cloud source and a browser. Verify by pointing a source at a Gist, editing it,
 * and watching that only the changed cards flash (not the whole grid) while scroll position holds.
 */
export function applyPatchToDom(diff, ctx) {
  const { S, cards, buildCard, releaseArt, paintOwned, removeFromSelection } = ctx;
  for (const a of diff.removed) {
    const c = cards.get(a.id);
    if (c) { releaseArt(c.el); c.el.remove(); cards.delete(a.id); }
    removeFromSelection?.(a.id);
    S.byId.delete(a.id);
  }
  for (const a of diff.added) {
    S.byId.set(a.id, a);
    if (!cards.has(a.id)) cards.set(a.id, buildCard(a));
    paintOwned(a);
  }
  for (const { after } of diff.changed) {
    S.byId.set(after.id, after);
    const c = cards.get(after.id);
    if (!c) continue;
    const meta = c.el.querySelector('.card-meta');
    if (meta) {
      const [t, ar, yr] = meta.children;
      if (t) t.textContent = after.title;
      if (ar) ar.textContent = after.artist;
      if (yr) yr.textContent = after.year || '—';
    }
    c.el.setAttribute('aria-label', `${after.title} by ${after.artist}${after.year ? ', ' + after.year : ''}`);
    paintOwned(after);
  }
  S.albums = [...S.byId.values()];
}
