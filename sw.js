const CACHE = 'crate-img-v1';
// Cross-origin <img> loads are opaque; Chrome pads each opaque entry (about 7 MB of quota), so keep the cap low.
const MAX_ENTRIES = 100;
const IMAGE_HOSTS = /(?:\.mzstatic\.com|\.dzcdn\.net|coverartarchive\.org|\.archive\.org|upload\.wikimedia\.org|lastfm\.freetls\.fastly\.net|\.discogs\.com)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.destination !== 'image' || !IMAGE_HOSTS.test(new URL(request.url).hostname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), hit = await cache.match(request);
    const network = fetch(request).then(async (res) => {
      if (res.ok || res.type === 'opaque') { await cache.put(request, res.clone()); trim(cache); }
      return res;
    }).catch(() => hit);
    return hit ?? network;
  })());
});
