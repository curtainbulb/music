import { lsGet, lsSet } from '../store/local.js';

/**
 * Per-album free-text notes, keyed by album id. One store, two writers: the detail-sheet notes field
 * (js/ui/views.js) and imported "notes" columns from CSV/TSV/JSON/.xlsx (js/ui/extras.js via
 * mergeImportedNotes). Both read and write the same localStorage key so neither silently loses the
 * other's data.
 */
const KEY = 'crate.notes.v1';

export function loadNotes() {
  try { return JSON.parse(lsGet(KEY, '{}')) || {}; } catch { return {}; }
}
export const saveNotes = (notes) => lsSet(KEY, JSON.stringify(notes));
export const getNote = (id) => loadNotes()[id] ?? '';

export function setNote(id, text) {
  const notes = loadNotes();
  if (text && text.trim()) notes[id] = text; else delete notes[id];
  saveNotes(notes);
  return notes;
}

/** Fills in a note for any imported album that has one and has no existing note yet (never overwrites
 * a note the user already wrote or edited in the detail sheet). Returns how many notes were added. */
export function mergeImportedNotes(albums) {
  const notes = loadNotes();
  let added = 0;
  for (const a of albums) {
    if (a.notes && a.notes.trim() && !(a.id in notes)) { notes[a.id] = a.notes.trim(); added++; }
  }
  if (added) saveNotes(notes);
  return added;
}
