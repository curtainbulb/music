/** Tiny key-value store on IndexedDB; degrades to memory when unavailable. */
export function createKv(name = 'crate-kv') {
  const mem = new Map();
  const ready = typeof indexedDB === 'undefined' ? Promise.resolve(null) : new Promise((resolve) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  return {
    async get(key) {
      const db = await ready;
      if (!db) return mem.get(key);
      return new Promise((resolve) => { const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(undefined); });
    },
    async set(key, value) {
      const db = await ready;
      if (!db) return void mem.set(key, value);
      await new Promise((resolve) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = tx.onerror = () => resolve(); });
    },
  };
}
