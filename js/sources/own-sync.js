import { READERS, WRITERS } from './drives.js';
import { getToken, clearToken } from './oauth.js';

/**
 * Cross-device ownership sync (user report: "when I tick something on one device it must get ticked
 * everywhere, there must be a copy of the list that gets updated"). The album *list* stays one-directional
 * (see docs/DEVLOG.md's "Cloud source" sections — read-only by design), but ownership is per-person state
 * that genuinely needs to round-trip, and the user already has a writable connection open to Dropbox/
 * pCloud once a drive is connected (see WRITERS in drives.js). This module just derives a small sidecar
 * path next to the connected album-list file and reads/writes a `{own, updatedAt}` JSON blob there — one
 * whole-map "newest `updatedAt` wins" merge, not a per-album CRDT. That's a real, documented trade-off (a
 * stale device that writes right after a newer one can clobber it), accepted because a true per-field
 * merge needs either server-side coordination or vector clocks this app has nowhere to run; "last device to
 * finish editing wins, same as every other field in this file" is the same model the album-list sync
 * already uses for conflicts, so it's consistent with the rest of the app rather than a new kind of risk.
 */
export function sidecarPathFor(path) {
  const slash = path.lastIndexOf('/'), dir = slash >= 0 ? path.slice(0, slash + 1) : '', base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.'), stem = dot > 0 ? base.slice(0, dot) : base;
  return `${dir}${stem}.own.json`;
}

/** Providers this module can actually read/write ownership for — a strict subset of READERS/OAUTH, since
 * OneDrive/Google/Box have no WRITERS entry and stay read-only drive sources. */
export const OWN_SYNC_PROVIDERS = Object.keys(WRITERS).filter((id) => id in READERS);

export async function pushOwnership(id, path, ownMap, signal) {
  if (!OWN_SYNC_PROVIDERS.includes(id)) return false;
  const token = getToken(id);
  if (!token) return false;
  const text = JSON.stringify({ own: ownMap, updatedAt: Date.now() });
  try { await WRITERS[id](sidecarPathFor(path), text, signal, token); return true; }
  catch (e) { if (e.auth) clearToken(id); throw e; }
}

/** Returns {own, updatedAt} from the remote sidecar, or null if there isn't one yet (first sync from this
 * provider) or nothing has changed since `validators`. Never throws on "file not found" — that's the
 * expected state before the first push from any device. */
export async function pullOwnership(id, path, validators, signal) {
  if (!OWN_SYNC_PROVIDERS.includes(id)) return null;
  const token = getToken(id);
  if (!token) return null;
  try {
    const res = await READERS[id](sidecarPathFor(path), validators, signal, token);
    if (res.notModified || !res.text) return null;
    const data = JSON.parse(res.text);
    if (!data || typeof data.own !== 'object' || typeof data.updatedAt !== 'number') return null;
    return { own: data.own, updatedAt: data.updatedAt, etag: res.etag };
  } catch (e) {
    if (e.auth) clearToken(id);
    if (/not found/.test(e.message || '')) return null; // no sidecar written yet from any device
    throw e;
  }
}
