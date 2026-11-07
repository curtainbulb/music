# Crate v4 changelog

Builds on v3 (see docs/DEVLOG.md slices 1-6). Nothing already marked done there was re-verified; this
lists what changed on top of it. Full detail, including UNTESTED notes and the design rationale
behind each item, is in docs/DEVLOG.md "Slice 7 (v4)" — this file is the flat per-section summary.

## 2.1 Cover art
- Added Last.fm and Discogs as optional keyed providers (`js/covers/providers.js`), same key-storage
  pattern as the AI providers. Discogs auths via header, not a URL param; Last.fm's API forces the key
  into the URL (no header mode exists), documented as an accepted, unavoidable exception.
- Near-screen (~1200px) and idle-sweep (`requestIdleCallback`) cover-queue tiers are now fed from
  `js/ui/views.js`; posters leaving near-screen range cancel their queued lookup.
- Cover `<img>` width/height and host `<link rel="preconnect">` confirmed present; preconnect list
  extended for the new provider hosts (best-effort, unverified without a live API response).

## 2.2 Import
- `.xlsx` import added via a single pinned, vendored dependency (SheetJS/`xlsx`), dynamically imported
  as an ES module. Not fetched in this sandbox (no network); `js/parser/xlsx.js` documents the exact
  pinned URL/version, the SRI step, and fails with a clear user-facing error until the vendor file is
  placed. ~30-line wrapper, replaceable by deleting one file and two call sites.
- CSV/TSV/JSON `notes` column now persists into the same per-album notes store the detail view uses
  (`js/ui/notes.js`, `localStorage` key `crate.notes.v1`); a re-import never overwrites a note the user
  already wrote by hand.
- The app's default/initial load now goes through the same `importText` parser the import dialog uses
  (`js/parser/formats.js`), replacing the old inline parser. One parser, one code path.

## 2.3 Cloud source (priority)
- MEGA and Box link handling added to `js/sources/links.js`. Both are refused with a clear,
  user-facing reason (MEGA: client-side encryption with no plain HTTPS endpoint; Box: share links
  serve an HTML preview, not raw bytes, and aren't CORS-enabled) and pointed at a working alternative
  (a GitHub Gist, or Box via "Connect and sync" OAuth2 PKCE, which already existed).
- New "Review" view: a pure diff module (`js/ui/patch.js`, `diffAlbums`) drives both the sync-summary
  "Review" link (added/removed/changed albums with before/after values, in the existing dialog system)
  and DOM patching — the sync path no longer does a full-list re-render. Only changed/added/removed
  `<card>` nodes are touched; cover cache, collapsed sections, filters, scroll position and multi-select
  survive a sync. `diffAlbums` has unit tests; the DOM-touching half is UNTESTED (needs a live browser).
- One-directional sync (cloud -> app only) unchanged; nothing here writes to a remote file.
- No CORS proxy added anywhere.

## 2.4 / 2.5 UI/UX and structure
- `js/main.js` is now the real entry point; `js/ai/smartpicks.js` holds the AI provider plumbing. The
  old global-coupling between `index.html`/`extras.js`/`views.js` is replaced with explicit
  imports/exports and two small extension-point objects (`App`, `Sheet`).
- Desktop sidebar (genres w/ counts, eras, ownership filter) and mobile bottom-sheet filters added.
- Detail-view close transition added (View Transitions API, with a FLIP fallback) to pair with the
  existing open transition. Animated stat counters, capped staggered entrance, and FLIP-based reorder
  animation added, all gated behind `prefers-reduced-motion`.
- Accessibility: focus-visible rings, dialog focus trap + return, `aria-live` regions for async status,
  44px touch targets on mobile controls.
- AI Smart Picks "nothing is sent until you press the button" notice confirmed present.
- Deferred: `css/base.css`/`css/components.css` split. `css/tokens.css` exists from v3; the ~226-line
  inline `<style>` block in `index.html` is still live. Judged too risky to do blind, by hand, in the
  same pass as the sync/patching rewrite, given it would touch selectors the new animation code depends
  on. See docs/DEVLOG.md for the reasoning. Full cross-breakpoint visual verification (360-2560px) also needs
  a real browser and is unmeasured.

## 2.6 Security re-pass
- Searched all of `index.html` and every `js/**/*.js` file for `innerHTML`: zero occurrences anywhere
  in the codebase, old or new. All DOM text insertion is `textContent` or `createElement`/`setAttribute`.
- JSONP risk section in docs/DEVLOG.md filled out in full: which hosts (iTunes, Deezer) use JSONP, the real
  blast radius (full page compromise — JSONP executes the response as script in this origin, no
  sandboxing is possible by construction), and why it's accepted (fixed, trusted, first-party endpoints,
  sanitized query-only input, no CORS-enabled alternative exists for either catalog today). Everything
  else (MusicBrainz, Cover Art Archive, Wikipedia, Last.fm, Discogs) is `fetch`-based JSON, not JSONP,
  and is called out as a materially smaller blast radius (bad data, not code execution).

## Tests
`node tests/run.mjs`: 29/29 passing (26 carried over + 3 new: MEGA/Box link rejection,
`diffAlbums`/`hasDiff`/`summarize`).

## Not fabricated
No Lighthouse/FCP/CLS numbers, cache hit-rate percentages, or CORS compatibility claims beyond the
expected/unlikely/unknown labels already in `links.js`/`drives.js`. See docs/DEVLOG.md "MEASURE: not yet run"
for the full list of what still needs a live browser.

## Slice 11: four previously-deferred items, wired and verified in a real browser

A Chromium/Playwright browser became available in this sandbox after Slice 10, so the four items Slice 10
explicitly left unwired ("needs a browser to judge, not a logic gap") were wired and verified:

- **Poster-choice modal auto-surfacing**: scoped to the single album the detail sheet is open for (never
  the grid, never while scrolling) — a confirmed cover-lookup miss shows an inline "Couldn't find a
  cover…Choose one…" row in the sheet, reusing the existing modal and pin path. Verified: the row appears
  on a forced miss, "Choose one…" opens/closes the modal correctly, and grid scrolling never triggers
  anything (explicitly tested).
- **AI key setup status icon**: a spinner/check/cross icon now sits beside the existing `#aiNote` text
  (text unchanged). Verified the checking→error transition end-to-end against a fake key with no real
  network, confirming a rejected key renders a clear failed state rather than hanging.
- **Synopsis**: a manual "Synopsis" button in the sheet (preserves "nothing sent until you press a button"),
  wired to the existing `generateSynopsis()`/AI chain plumbing with abort-on-sheet-change. Verified the
  loading→stub-fallback path with no AI key configured, and explicitly race-tested that switching sheets
  mid-request never lets a stale response land in the wrong sheet.
- **File auto-fetch**: added as an opt-in "Scan for a file to auto-load…" command-palette entry, routed
  through the existing manual-import dialog so it cannot race `boot()`'s cloud-source logic. Supports a
  local-folder scan (File System Access API, Chromium/Edge only, documented) and a GitHub-repo fallback.
  Verified the palette entry and the folder-scan's cancel path end-to-end; the GitHub fallback's network
  calls could not be verified live (this sandbox's egress proxy blocks `api.github.com`, same as it blocks
  every cover-provider host) — its pure logic was already unit-tested in Slice 10.

No new pure logic was added (all four are DOM/async wiring), so `node tests/run.mjs` stays at 36/36 and
`grep -rn innerHTML` stays at zero matches. Full detail, including exact verification steps and honestly
unverified gaps, is in docs/DEVLOG.md "Slice 11".
