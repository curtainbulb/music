const HIT_TTL = 90 * 864e5;
const MISS_BACKOFF = [36e5, 864e5, 7 * 864e5];
const FLUSH_MS = 500;

/** Entry: {id, url, provider, score, fetchedAt, misses, retryAt}. url === '' marks a miss. Falls back to memory when IndexedDB is unavailable. */
export function createCoverCache(name = 'crate-covers') {
  const mem = new Map(), pending = new Map();
  let flushTimer = null;
  const dbReady = typeof indexedDB === 'undefined' ? Promise.resolve(null) : new Promise((resolve) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('covers', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  const store = (db, mode) => db.transaction('covers', mode).objectStore('covers');
  const read = async (id) => {
    const db = await dbReady;
    if (!db) return null;
    return new Promise((resolve) => {
      const req = store(db, 'readonly').get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  };
  const objectUrls = new Map();
  const objectUrl = (e) => {
    const old = objectUrls.get(e.id);
    if (old?.blob === e.blob) return old.url;
    if (old) URL.revokeObjectURL(old.url);
    const url = URL.createObjectURL(e.blob);
    objectUrls.set(e.id, { blob: e.blob, url });
    return url;
  };
  const isFresh = (e) => e && (e.pinned || (e.url ? Date.now() - e.fetchedAt < HIT_TTL : Date.now() < e.retryAt));
  async function flush() {
    flushTimer = null;
    const batch = [...pending.values()];
    pending.clear();
    const db = await dbReady;
    if (!db || !batch.length) return;
    const st = store(db, 'readwrite');
    for (const entry of batch) st.put(entry);
  }
  const write = (entry) => { mem.set(entry.id, entry); pending.set(entry.id, entry); flushTimer ??= setTimeout(flush, FLUSH_MS); };
  const load = async (id) => { const e = mem.get(id) ?? await read(id); if (e) mem.set(id, e); return e; };

  return {
    async get(id) { const e = await load(id); if (!isFresh(e)) return null; return e.blob ? { ...e, url: objectUrl(e) } : e; },
    async peek(id) { return (await load(id)) ?? null; },
    put(entry) { write(entry); },
    putHit({ id, url, provider, score }) { write({ id, url, provider, score, fetchedAt: Date.now(), misses: 0, retryAt: 0 }); },
    async putMiss(id) {
      const prev = await load(id);
      const misses = (prev && !prev.url ? prev.misses : 0) + 1;
      write({ id, url: '', provider: '', score: 0, fetchedAt: Date.now(), misses, retryAt: Date.now() + MISS_BACKOFF[Math.min(misses, 3) - 1] });
    },
    async del(id) {
      mem.delete(id); pending.delete(id);
      const db = await dbReady;
      if (db) store(db, 'readwrite').delete(id);
    },
    /** Returns the removed entries so the caller can offer Undo. Pinned user covers are never removed. */
    async clearMisses() {
      await flush();
      const removed = new Map();
      for (const [id, e] of mem) if (!e.url && !e.blob) { removed.set(id, e); mem.delete(id); }
      const db = await dbReady;
      if (!db) return [...removed.values()];
      await new Promise((resolve) => {
        const tx = db.transaction('covers', 'readwrite');
        tx.objectStore('covers').openCursor().onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          if (!cursor.value.url && !cursor.value.blob) { removed.set(cursor.value.id, cursor.value); cursor.delete(); }
          cursor.continue();
        };
        tx.oncomplete = tx.onerror = () => resolve();
      });
      return [...removed.values()];
    },
  };
}
