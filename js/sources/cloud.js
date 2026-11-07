import { MAX_BYTES } from '../parser/formats.js';

const hashText = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Polls one source. onChange(text) fires only when content differs from the last good copy.
 * `read(validators, signal) -> {notModified} | {text, etag}` replaces the default HTTP GET (used by the drive connectors).
 * Default GET sends conditional headers; if the preflight fails it retries bare and compares a hash.
 */
export function createCloudSource({ url, kv, onChange, onState, read, minutes = 5 }) {
  let timer = null, failures = 0, running = false, lastSynced = 0;
  const key = `cloud:${url}`;
  const state = (status, message = '') => onState({ status, lastSynced, message });

  async function httpRead(saved, signal) {
    const get = (validators) => {
      const headers = {};
      if (validators?.etag) headers['If-None-Match'] = validators.etag;
      if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
      return fetch(url, { signal, headers, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-cache' });
    };
    let res;
    try { res = await get(saved); } catch (e) { if (e.name === 'TimeoutError') throw e; res = await get(null); }
    if (res.status === 304) return { notModified: true };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('remote file larger than 8 MB');
    return { text: await res.text(), etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined };
  }

  async function check() {
    if (running) return;
    running = true;
    const saved = (await kv.get(key)) ?? {};
    if (!navigator.onLine) { running = false; return state('offline', saved.text ? 'offline, showing last synced copy' : 'offline'); }
    state('checking');
    try {
      const got = await (read ?? httpRead)(saved, AbortSignal.timeout(15000));
      lastSynced = Date.now(); failures = 0;
      if (got.notModified) return state('ok');
      if (got.text.length > MAX_BYTES) throw new Error('remote file larger than 8 MB');
      const hash = await hashText(got.text);
      await kv.set(key, { text: got.text, hash, etag: got.etag, lastModified: got.lastModified });
      if (hash !== saved.hash) onChange(got.text);
      state('ok');
    } catch (e) {
      failures++;
      state('error', `${e.message}${e instanceof TypeError ? ' (network or CORS block: this host may not allow cross-origin reads)' : ''}`);
    } finally { running = false; schedule(); }
  }

  function schedule() {
    clearTimeout(timer);
    if (!minutes || document.hidden) return;
    timer = setTimeout(check, minutes * 60000 * 2 ** Math.min(failures, 4) * (0.85 + Math.random() * 0.3));
  }
  const onVisibility = () => { if (document.hidden) clearTimeout(timer); else check(); };
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('online', check);

  return {
    checkNow: check,
    async cached() { return (await kv.get(key))?.text ?? null; },
    stop() { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); removeEventListener('online', check); },
  };
}
