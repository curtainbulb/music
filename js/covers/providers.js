import { createLimiter } from './limiter.js';
import { normalize } from './matcher.js';

let jsonpSeq = 0;
/** Script-tag request for hosts that send no CORS headers. Executes remote code: keep the host list minimal. */
function jsonp(url, param, signal) {
  return new Promise((resolve, reject) => {
    const name = `__crateCb${++jsonpSeq}`, tag = document.createElement('script');
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => { window[name] = () => {}; tag.remove(); signal.removeEventListener('abort', onAbort); };
    if (signal.aborted) return reject(signal.reason);
    window[name] = (data) => { cleanup(); resolve(data); };
    tag.onerror = () => { cleanup(); reject(new Error('jsonp load failed')); };
    signal.addEventListener('abort', onAbort, { once: true });
    tag.referrerPolicy = 'no-referrer';
    tag.src = `${url}&${param}=${name}`;
    document.head.append(tag);
  });
}

async function getJson(url, signal, headers) {
  const res = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const quote = (s) => String(s).replace(/["\\]/g, ' ');
const yearOf = (s) => (/\b(19|20)\d{2}\b/.exec(s ?? '') || [])[0] | 0 || null;

const itunes = {
  name: 'itunes',
  limiter: createLimiter({ ratePerSec: 0.33, burst: 2 }), // Apple documents roughly 20 calls/min
  async find(album, signal) {
    const term = encodeURIComponent(`${album.artist} ${album.title}`);
    const data = await jsonp(`https://itunes.apple.com/search?term=${term}&media=music&entity=album&limit=10&country=US`, 'callback', signal);
    return (data.results ?? []).filter((r) => r.artworkUrl100).map((r) => ({
      artist: r.artistName, title: r.collectionName, year: yearOf(r.releaseDate),
      url: r.artworkUrl100.replace(/\d+x\d+bb\./, '200x200bb.'),
    }));
  },
};

const deezer = {
  name: 'deezer',
  limiter: createLimiter({ ratePerSec: 5, burst: 5 }), // documented: 50 requests / 5 s
  async find(album, signal) {
    const q = encodeURIComponent(`artist:"${quote(album.artist)}" album:"${quote(album.title)}"`);
    const data = await jsonp(`https://api.deezer.com/search/album?q=${q}&limit=10&output=jsonp`, 'callback', signal);
    return (data.data ?? []).filter((r) => r.cover_medium).map((r) => ({
      artist: r.artist?.name, title: r.title, year: null, url: r.cover_medium,
    }));
  },
};

const musicbrainz = {
  name: 'musicbrainz',
  limiter: createLimiter({ ratePerSec: 1, burst: 1 }), // documented: 1 request/s per client
  async find(album, signal) {
    const q = encodeURIComponent(`artist:"${quote(album.artist)}" AND releasegroup:"${quote(album.title)}"`);
    const data = await getJson(`https://musicbrainz.org/ws/2/release-group/?query=${q}&fmt=json&limit=5`, signal);
    const groups = (data['release-groups'] ?? []).map((g) => ({
      artist: g['artist-credit']?.[0]?.name, title: g.title, year: yearOf(g['first-release-date']),
      url: `https://coverartarchive.org/release-group/${g.id}/front-250`,
    }));
    const found = [];
    for (const g of groups.slice(0, 3)) { // CAA 404s when no art exists; probe before offering the URL
      const probe = await fetch(g.url, { method: 'HEAD', signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (probe.ok) found.push(g);
      else if (probe.status !== 404) throw new Error(`CAA HTTP ${probe.status}`);
    }
    return found;
  },
};

const wikipedia = {
  name: 'wikipedia',
  limiter: createLimiter({ ratePerSec: 5, burst: 3 }),
  async find(album, signal) {
    const search = encodeURIComponent(`${album.artist} ${album.title} album`);
    const data = await getJson(`https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrlimit=3&gsrsearch=${search}&prop=pageimages%7Cdescription&piprop=thumbnail&pithumbsize=500`, signal);
    return Object.values(data.query?.pages ?? {}).filter((p) => p.thumbnail?.source).map((p) => ({
      // description reads like "1969 studio album by the Beatles"; no artist field exists on this endpoint
      artist: normalize(p.description ?? '').includes(normalize(album.artist)) ? album.artist : '',
      title: p.title.replace(/\s*\([^)]*\)\s*$/, ''), year: yearOf(p.description), url: p.thumbnail.source,
    }));
  },
};

/**
 * Last.fm album.search — requires a free API key. Last.fm's REST API only accepts `api_key` as a query
 * parameter (it has no header-based auth mode), so this is the one provider where the key unavoidably
 * appears in the request URL; it is never logged, never stored in a URL, and `referrerPolicy: 'no-referrer'`
 * keeps it out of any Referer header sent to a third party. CORS: Last.fm's JSON API is commonly used from
 * browser apps; UNTESTED here (no network in this sandbox) but no User-Agent or other unsettable header is
 * required, unlike Discogs below.
 */
function createLastfm(getKey) {
  return {
    name: 'lastfm',
    limiter: createLimiter({ ratePerSec: 2, burst: 3 }), // Last.fm asks for roughly 5 req/s per key; kept conservative
    async find(album, signal) {
      const key = getKey('lastfm');
      if (!key) return [];
      const q = new URLSearchParams({ method: 'album.search', album: `${album.artist} ${album.title}`, api_key: key, format: 'json', limit: '10' });
      const data = await getJson(`https://ws.audioscrobbler.com/2.0/?${q}`, signal);
      if (data.error) throw new Error(`lastfm ${data.error}: ${data.message || ''}`);
      const results = data.results?.albummatches?.album ?? [];
      return results.map((r) => {
        const images = Array.isArray(r.image) ? r.image : [];
        const best = [...images].reverse().find((i) => i['#text']);
        return { artist: r.artist, title: r.name, year: null, url: best ? best['#text'] : null };
      }).filter((r) => r.url);
    },
  };
}

/**
 * Discogs database/search — requires a personal access token, sent as an `Authorization: Discogs
 * token=...` header rather than a query param, so the key never appears in a URL (logs, browser history,
 * Referer). CORS: Discogs' REST API documents a User-Agent requirement that browsers will not let a
 * script set (the browser sends its own), and Discogs' CORS support for arbitrary origins is not
 * documented anywhere consulted while writing this. UNTESTED, and more likely than the other providers
 * here to simply fail from a static page; if it does, that's an accepted limitation (no proxy will be
 * added for it), not a bug to chase.
 */
function createDiscogs(getKey) {
  return {
    name: 'discogs',
    limiter: createLimiter({ ratePerSec: 1, burst: 2 }), // Discogs: 60 req/min authenticated, kept well under
    async find(album, signal) {
      const key = getKey('discogs');
      if (!key) return [];
      const q = new URLSearchParams({ q: `${album.artist} ${album.title}`, type: 'release', per_page: '10' });
      const data = await getJson(`https://api.discogs.com/database/search?${q}`, signal, { Authorization: `Discogs token=${key}` });
      return (data.results ?? []).filter((r) => r.cover_image || r.thumb).map((r) => {
        const m = /^(.*?)\s*-\s*(.*)$/.exec(r.title || '');
        return { artist: m ? m[1] : album.artist, title: m ? m[2] : r.title, year: r.year ? +r.year : null, url: r.cover_image || r.thumb };
      });
    },
  };
}

/** getKey(name) -> '' | string, looked up fresh on every call so a key saved mid-session works without a reload.
 * Wikipedia is placed LAST (brief item 3b): it needs no key and is always available, so it's the final,
 * no-key fallback after every keyed/unkeyed provider that's more likely to have a correctly-tagged music
 * cover, not a replacement for any of them. (It existed from Slice 1, mid-chain via the Action API search
 * endpoint; moved to the end of the chain here rather than duplicated as a second REST-summary provider,
 * since a single Wikipedia entry in the breaker/stats machinery is simpler than two and the Action API
 * version already returns a thumbnail/description shaped exactly like what a REST-summary call would.) */
export const createProviders = (getKey = () => '') => [itunes, musicbrainz, deezer, createLastfm(getKey), createDiscogs(getKey), wikipedia];

/** Swap the size segment in a stored URL. Providers without a size segment return the URL unchanged. */
export function resizeCover(url, px) {
  return url.replace(/\d+x\d+bb\./, `${px}x${px}bb.`).replace(/\/\d+x\d+-/, `/${px}x${px}-`).replace(/front-\d+$/, `front-${px <= 250 ? 250 : 500}`);
}
