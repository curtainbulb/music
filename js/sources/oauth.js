const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const challengeOf = async (verifier) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

/** flow 'pkce': authorization code + PKCE, token exchange from the browser. flow 'implicit': token returned in the URL fragment. */
export const OAUTH = {
  // files.content.write added alongside the existing read scopes so ownership ticks can be written back
  // to a small sidecar file next to the synced album list (see js/sources/own-sync.js) — the album list
  // itself stays read-only/one-directional, only the ownership sidecar is ever written by this app.
  dropbox: { label: 'Dropbox', flow: 'pkce', authUrl: 'https://www.dropbox.com/oauth2/authorize', tokenUrl: 'https://api.dropboxapi.com/oauth2/token', scope: 'files.metadata.read files.content.read files.content.write' },
  onedrive: { label: 'Microsoft OneDrive', flow: 'pkce', authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scope: 'Files.Read' },
  google: { label: 'Google Drive', flow: 'implicit', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', scope: 'https://www.googleapis.com/auth/drive.readonly' },
  pcloud: { label: 'pCloud', flow: 'implicit', authUrl: 'https://my.pcloud.com/oauth2/authorize' },
  // Box added PKCE (code_challenge/code_challenge_method) for "public client" custom apps so a
  // browser-only app does not need a client secret; see https://developer.box.com/guides/authentication/pkce/
  // UNTESTED: this app has never exchanged a real Box authorization code; confirm the token endpoint
  // accepts `code_verifier` with no `client_secret` for your app before relying on it (if Box rejects
  // it, Box is a blocker like MEGA, not usable from a static page — do not add a secret here).
  box: { label: 'Box', flow: 'pkce', authUrl: 'https://account.box.com/api/oauth2/authorize', tokenUrl: 'https://api.box.com/oauth2/token' },
};

export function buildAuthUrl(id, { clientId, redirectUri, state, challenge }) {
  const p = OAUTH[id], url = new URL(p.authUrl);
  const q = { client_id: clientId, redirect_uri: redirectUri, state, response_type: p.flow === 'pkce' ? 'code' : 'token' };
  if (p.scope) q.scope = p.scope;
  if (p.flow === 'pkce') { q.code_challenge = challenge; q.code_challenge_method = 'S256'; }
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  return url.href;
}

export function parseReturn(href) {
  const u = new URL(href), frag = new URLSearchParams(u.hash.slice(1)), pick = (k) => u.searchParams.get(k) ?? frag.get(k);
  return { state: pick('state'), code: pick('code'), accessToken: frag.get('access_token'), expiresIn: Number(frag.get('expires_in')) || 3600, locationId: Number(frag.get('locationid')) || 1, error: pick('error_description') ?? pick('error') };
}

const tokenStore = () => (localStorage.getItem('crate.tok.remember') === '1' ? localStorage : sessionStorage);
export function getToken(id) {
  try {
    const t = JSON.parse(tokenStore().getItem(`crate.tok.${id}`));
    return t && t.exp > Date.now() + 30000 ? t : null;
  } catch { return null; }
}
const saveToken = (id, t) => { try { tokenStore().setItem(`crate.tok.${id}`, JSON.stringify(t)); } catch { /* storage blocked */ } };
export const clearToken = (id) => { try { sessionStorage.removeItem(`crate.tok.${id}`); localStorage.removeItem(`crate.tok.${id}`); } catch { /* storage blocked */ } };

const redirectUri = () => location.origin + location.pathname;

export async function beginAuth(id, clientId, path) {
  const state = randomToken(16), verifier = randomToken(48);
  sessionStorage.setItem('crate.oauth.pending', JSON.stringify({ provider: id, state, verifier, path, redirectUri: redirectUri() }));
  location.assign(buildAuthUrl(id, { clientId, redirectUri: redirectUri(), state, challenge: await challengeOf(verifier) }));
}

/** Call once at startup. Returns {provider, path} after a verified return from a provider, else null. Throws on provider errors. */
export async function completeAuthIfReturning(clientIds) {
  const ret = parseReturn(location.href);
  if (!ret.state) return null;
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem('crate.oauth.pending')); } catch { /* none */ }
  if (!pending || pending.state !== ret.state) return null;
  sessionStorage.removeItem('crate.oauth.pending');
  history.replaceState(null, '', redirectUri());
  if (ret.error) throw new Error(ret.error);
  const p = OAUTH[pending.provider];
  if (p.flow === 'pkce') {
    const res = await fetch(p.tokenUrl, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: ret.code, redirect_uri: pending.redirectUri, client_id: clientIds[pending.provider].clientId, code_verifier: pending.verifier }),
    });
    if (!res.ok) throw new Error(`token exchange failed (HTTP ${res.status})`);
    const data = await res.json();
    saveToken(pending.provider, { access: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
  } else {
    if (!ret.accessToken) throw new Error('provider returned no token');
    saveToken(pending.provider, { access: ret.accessToken, exp: Date.now() + ret.expiresIn * 1000, locationid: ret.locationId });
  }
  return { provider: pending.provider, path: pending.path };
}
