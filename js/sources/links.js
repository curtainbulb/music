/** True when a MEGA share link matches either the current (/file/<id>#<key>) or legacy (#!<id>!<key>) format. */
export const isMegaUrl = (host) => host === 'mega.nz' || host === 'mega.io' || host === 'mega.co.nz';
/** True for both the generic app.box.com/s/<token> form and an enterprise subdomain, e.g. acme.app.box.com/s/<token>. */
export const isBoxUrl = (host) => host === 'app.box.com' || host.endsWith('.app.box.com');

/** Share link -> direct link. cors is a claim to check, not a fact: 'expected' | 'unlikely' | 'unknown'. */
export function normalizeShareUrl(input) {
  let u;
  try { u = new URL(input.trim()); } catch { return { error: 'not a valid URL' }; }
  if (u.protocol !== 'https:') return { error: 'only https links are accepted' };
  const host = u.hostname.replace(/^www\./, '');
  if (isMegaUrl(host)) {
    // MEGA file contents are AES-encrypted; the key lives in the URL fragment and decryption only
    // happens client-side through MEGA's own SDK (megajs or the official MEGA SDK). There is no plain
    // HTTPS endpoint that serves decrypted bytes, so this can never become a bare fetchable raw URL —
    // unlike Dropbox/Drive/OneDrive, this is not a CORS problem, it is a "no such endpoint" problem.
    return {
      error: 'MEGA links are not supported: files are end-to-end encrypted and need MEGA\'s own SDK (not vendored in this build) to decrypt in the browser. Use a GitHub Gist or raw GitHub file instead.',
      unsupported: 'mega',
    };
  }
  if (isBoxUrl(host)) {
    // A Box shared link (app.box.com/s/<token>) serves an HTML preview page to a plain cross-origin
    // fetch, not raw bytes, and is not CORS-enabled for arbitrary origins. Reading it needs the Box
    // Content API with an access token, which this app supports separately as a connected drive
    // (see js/sources/drives.js + the "Connect and sync" provider list) — that path uses OAuth2 PKCE,
    // so no client secret or proxy is needed. The plain "paste a link" path below can't do it.
    return {
      error: 'Box share links are not readable as a plain URL (no CORS, and the link serves an HTML preview page, not the file). Use "Connect and sync" with the Box provider instead, or a GitHub Gist.',
      unsupported: 'box',
    };
  }
  if (host === 'github.com') {
    const m = /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(u.pathname);
    if (m) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, cors: 'expected' };
  }
  if (host === 'gist.github.com') {
    const m = /^\/([^/]+)\/([0-9a-f]+)\/?$/.exec(u.pathname);
    if (m) return { url: `https://gist.githubusercontent.com/${m[1]}/${m[2]}/raw`, cors: 'expected' };
  }
  if (host === 'raw.githubusercontent.com' || host === 'gist.githubusercontent.com') return { url: u.href, cors: 'expected' };
  if (host.endsWith('dropbox.com')) {
    u.searchParams.delete('dl'); u.searchParams.set('raw', '1');
    return { url: u.href, cors: 'unknown', hint: 'Dropbox may block cross-origin reads; a GitHub Gist is the reliable option.' };
  }
  if (host === 'drive.google.com') {
    const id = /\/file\/d\/([^/]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get('id');
    if (id) return { url: `https://drive.google.com/uc?export=download&id=${id}`, cors: 'unlikely', hint: 'Google Drive usually blocks cross-origin reads. Use a GitHub Gist.' };
  }
  if (host.endsWith('onedrive.live.com') || host.endsWith('1drv.ms') || host.endsWith('sharepoint.com')) {
    return { url: u.href, cors: 'unlikely', hint: 'OneDrive usually blocks cross-origin reads. Use a GitHub Gist.' };
  }
  return { url: u.href, cors: 'unknown' };
}
