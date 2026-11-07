# Crate

A static, no-build music-collection tracker: import a markdown/CSV/JSON list of albums, browse by genre/era,
mark what you own, and get auto-fetched cover art from public APIs. Pure HTML/CSS/JS modules — no framework,
no bundler, no backend.

Static, no build step. Serve the folder over http(s) (modules and the service worker do not load from file://).

## Run locally
```
python3 -m http.server 8000
```
Open http://localhost:8000/. Tests: `node tests/run.mjs` or open `/tests/index.html` in a browser.

## Deploy to GitHub Pages
1. Push this repo to GitHub. 2. Settings > Pages > Deploy from branch, root. 3. Open the Pages URL.

## Project layout
```
index.html          entry page (CSP, markup, dialogs)
css/tokens.css       design tokens (spacing, color, motion)
js/main.js           app entry point, state, rendering
js/ai/               Smart Picks / synopsis AI provider plumbing
js/covers/           cover-art lookup pipeline (providers, matching, cache)
js/parser/           import format parsing (md/txt/csv/tsv/json/opml/xlsx) + export
js/sources/          cloud source links, OAuth drives, GitHub auto-detect
js/store/            localStorage/IndexedDB wrappers
js/ui/               import dialog, command palette, grid/list/table views
sw.js                service worker (cover-image caching)
tests/               node tests/run.mjs — pure-logic unit tests, no browser needed
docs/DEVLOG.md        full build history, design decisions, what's verified vs. not
CHANGELOG.md          flat per-release summary
config.json          optional default cloud source + OAuth client ids
```

## Status
See `docs/DEVLOG.md` for the complete development history and `CHANGELOG.md` for a flat summary. Every
test-passing claim and "verified" note in those files was actually run — anything not run is called out
explicitly as untested rather than assumed.

## Default cloud source
Either put a link in `config.json` (`{ "source": "https://gist.github.com/you/id" }`) or open `?src=https://…`. A source saved in the app (import dialog, "Keep this URL") wins over `config.json`. GitHub raw and Gist links are the intended hosts; Drive and OneDrive usually block cross-origin reads.

## Import / export
Import: Ctrl/Cmd+K > "Import albums…" or the ⤒ button (files, drop, paste, URL). Formats: .md .txt .csv .tsv .json .opml.
JSON schema: `{"sections":[{"name":"Rock","albums":[{"artist":"","title":"","year":1999,"owned":true}]}]}` or a bare array of `{artist,title,year,genre,owned}`.

## Cloud drives (OAuth, no backend)
Register your own app with each provider, add the redirect URI (your page URL exactly, e.g. `https://you.github.io/crate/`) and put the client id in `config.json` under `oauth`.
| Provider | Flow | Register at | Scope |
|---|---|---|---|
| Dropbox | PKCE | dropbox.com/developers/apps | files.metadata.read, files.content.read |
| OneDrive | PKCE (SPA platform) | Entra admin center, App registrations | Files.Read |
| Google Drive | implicit token | Google Cloud Console, OAuth client "Web", enable Drive API | drive.readonly |
| pCloud | implicit token | docs.pcloud.com, My apps | default |
Then: ⤒ Import > pick provider > enter the file path (Dropbox `/crate/albums.md`, OneDrive `crate/albums.md`, pCloud `/crate/albums.md`, Drive a file name or `id:<fileId>`) > Connect and sync. Tokens live in sessionStorage; set `localStorage['crate.tok.remember']='1'` to keep them on the device.
