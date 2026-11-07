/**
 * File auto-fetch (brief item 6), pure half: given a directory listing, pick which `.md`/`.txt` file to
 * auto-load when no explicit source is already configured, preferring the MOST RECENTLY MODIFIED candidate
 * rather than an arbitrary first match, with every candidate still returned for a picker UI.
 *
 * `entries` is a plain array of {name, modifiedAt} — modifiedAt is a number (epoch ms) or null/undefined
 * when the source can't report one (see the per-source notes below). Kept free of fetch/DOM so it can be
 * unit-tested directly; the two real listing sources are:
 *
 * - Local folder (served over http(s), not file://): there is no standard directory-listing API in a
 *   browser for an arbitrary static file server, so "root directory" here means whatever the page can
 *   already reach — this module does not invent a server-side listing endpoint. Where the dev server used
 *   for this app (`python -m http.server`, see index.html's error state) happens to serve a directory
 *   index as HTML, that HTML carries file mtimes in a server-specific format with no modifiedAt we can
 *   trust across servers, so a local listing can only be built from candidates the caller already knows
 *   about (e.g. a File System Access API directory handle, which does expose `getFile().lastModified`,
 *   when the browser/user grants it) — not implemented here, since it needs a user gesture to grant folder
 *   access and there is no browser in this sandbox to drive that gesture.
 * - GitHub repo root tree via the Contents API (`js/sources/drives.js` already reads individual files from
 *   Dropbox/OneDrive/Google/Box by path; this reuses that reader shape). The Contents API's directory
 *   listing (`GET /repos/{owner}/{repo}/contents/`) does NOT include a last-modified timestamp per file —
 *   getting one needs a separate `GET /commits?path=...&per_page=1` call per candidate file, which burns
 *   through GitHub's unauthenticated 60-requests/hour limit fast on a repo with more than a few candidate
 *   files. `listGithubRootCandidates` below fetches the directory listing (candidates with modifiedAt:
 *   null); a caller that wants true "most recently modified" ordering can call `fetchGithubModifiedTime`
 *   per candidate (capped and opt-in) to fill in modifiedAt before calling `pickAutoFile`. UNTESTED beyond
 *   the pure sort below: no network in this sandbox to confirm the Contents/commits API shapes.
 */
const CANDIDATE_RE = /\.(md|markdown|txt)$/i;

/** Pure: given entries (any order, any modifiedAt presence), return { best, all } where `all` is every
 * .md/.txt candidate (for a picker to list) and `best` is the one to auto-load — most recently modified
 * first; entries with no modifiedAt sort after every entry that has one; ties (or all-null) keep the
 * original listing order so the result is deterministic. */
export function pickAutoFile(entries) {
  const all = (entries || []).filter((e) => e && CANDIDATE_RE.test(e.name));
  const withIndex = all.map((e, i) => ({ e, i }));
  withIndex.sort((a, b) => {
    const am = a.e.modifiedAt, bm = b.e.modifiedAt;
    if (am == null && bm == null) return a.i - b.i;
    if (am == null) return 1;
    if (bm == null) return -1;
    return bm - am || a.i - b.i;
  });
  return { all, best: withIndex.length ? withIndex[0].e : null };
}

/** GitHub Contents API directory listing, filtered to .md/.txt candidates. No modifiedAt (see header
 * comment); the caller decides whether per-file commit lookups are worth the rate-limit cost. */
export async function listGithubRootCandidates(owner, repo, signal, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/`, { signal, headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`GitHub contents API HTTP ${res.status}`);
  const items = await res.json();
  return (items || []).filter((it) => it.type === 'file' && CANDIDATE_RE.test(it.name)).map((it) => ({ name: it.name, path: it.path, modifiedAt: null, downloadUrl: it.download_url }));
}

/** One commit-date lookup for a single file path, to fill in modifiedAt before pickAutoFile. Callers
 * should cap how many of these they issue per boot (brief: "prefers most-recently-modified ... with the
 * picker surfacing all of them") to stay inside GitHub's unauthenticated rate limit. */
export async function fetchGithubModifiedTime(owner, repo, path, signal, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(path)}&per_page=1`, { signal, headers, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`GitHub commits API HTTP ${res.status}`);
  const commits = await res.json();
  const date = commits?.[0]?.commit?.committer?.date || commits?.[0]?.commit?.author?.date;
  return date ? Date.parse(date) : null;
}
