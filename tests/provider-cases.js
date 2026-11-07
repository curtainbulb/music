import { challengeOf, buildAuthUrl, parseReturn, OAUTH } from '../js/sources/oauth.js';
import { asciiJson, encodePath } from '../js/sources/drives.js';

const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

export const providerCases = [
  ['PKCE S256 matches the RFC 7636 appendix B vector', async () => eq(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'challenge')],
  ['pkce auth URL carries challenge, implicit URL does not', () => {
    const a = new URL(buildAuthUrl('dropbox', { clientId: 'c', redirectUri: 'https://x/', state: 's', challenge: 'ch' }));
    eq([a.searchParams.get('response_type'), a.searchParams.get('code_challenge_method'), a.searchParams.get('code_challenge')], ['code', 'S256', 'ch'], 'dropbox');
    const g = new URL(buildAuthUrl('google', { clientId: 'c', redirectUri: 'https://x/', state: 's' }));
    eq([g.searchParams.get('response_type'), g.searchParams.has('code_challenge')], ['token', false], 'google');
  }],
  ['parseReturn reads code from query and token from fragment', () => {
    eq(parseReturn('https://x/?code=abc&state=s1').code, 'abc', 'code');
    const r = parseReturn('https://x/#access_token=tok&expires_in=100&locationid=2&state=s2');
    eq([r.accessToken, r.expiresIn, r.locationId, r.state], ['tok', 100, 2, 's2'], 'fragment');
    eq(parseReturn('https://x/?error=access_denied&state=s').error, 'access_denied', 'error');
  }],
  ['dropbox arg escapes non-ASCII; onedrive path encodes segments', () => {
    eq(asciiJson({ path: '/Sigur Rós.md' }), '{"path":"/Sigur R\\u00f3s.md"}', 'ascii');
    eq(encodePath('/a b/c#d.md'), 'a%20b/c%23d.md', 'encode');
  }],
  ['every OAuth provider has a known flow and auth host', () => { for (const p of Object.values(OAUTH)) if (!['pkce', 'implicit'].includes(p.flow) || !p.authUrl.startsWith('https://')) throw new Error(p.label); }],
];
