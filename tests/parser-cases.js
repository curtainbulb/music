import { importText, detectFormat, parseDelimited, applyImport } from '../js/parser/formats.js';
import { toCsv, toMarkdown, toJson } from '../js/parser/export.js';
import { normalizeShareUrl } from '../js/sources/links.js';
import { diffAlbums, hasDiff, summarize } from '../js/ui/patch.js';
import { splitDualTitle } from '../js/covers/matcher.js';
import { pickByPriority, PRIORITY, createCoverService } from '../js/covers/service.js';
import { detectKeyProvider, checkSynopsis, synopsisStub } from '../js/ai/smartpicks.js';
import { pickAutoFile } from '../js/sources/autodetect.js';

const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

// js/ui/notes.js and js/store/local.js read/write window.localStorage, which Node has no global for;
// a tiny in-memory polyfill lets mergeImportedNotes' persistence actually be exercised here instead of
// silently no-oping through local.js's try/catch guards.
if (typeof globalThis.localStorage === 'undefined') {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => { backing.set(k, String(v)); },
    removeItem: (k) => { backing.delete(k); },
  };
}

export const parserCases = [
  ['md keeps existing behaviour', () => {
    const r = importText('a.md', '## ROCK\n- [x] Pixies - Doolittle (1989)\n- Weezer - Weezer (1994)\nnot an album line - -');
    eq(r.albums.length, 2, 'count'); eq(r.albums[0].mdOwned, true, 'owned'); eq(r.albums[0].id, 'pixies|doolittle|1989', 'id');
  }],
  ['csv: quotes, BOM, commas in fields, owned column', () => {
    const r = importText('a.csv', '\uFEFFArtist,Album,Year,Genre,Owned\n"Earth, Wind & Fire","That\'s the Way ""Live""",1975,FUNK,yes\nPixies,Doolittle,1989,ROCK,no\n,Bad,1999,ROCK,no');
    eq(r.albums.length, 2, 'count'); eq(r.albums[0].artist, 'Earth, Wind & Fire', 'artist'); eq(r.albums[0].mdOwned, true, 'owned'); eq(r.skipped.length, 1, 'skipped');
  }],
  ['tsv detected by sniffing', () => eq(detectFormat('x', 'artist\ttitle\tyear\nA\tB\t1999'), 'tsv', 'fmt')],
  ['csv field with newline inside quotes', () => eq(parseDelimited('a,b\n"x\ny",z'), [['a', 'b'], ['x\ny', 'z']], 'rows')],
  ['json array and sections forms', () => {
    eq(importText('a.json', '[{"artist":"Pixies","title":"Doolittle","year":1989,"owned":true,"genre":"rock"}]').albums.length, 1, 'array');
    const r = importText('a.json', '{"sections":[{"name":"Metal","albums":[{"artist":"Slayer","title":"Reign in Blood","year":1986}]}]}');
    eq(r.albums[0].section, 'METAL', 'section');
    eq(importText('a.json', '{oops').skipped.length, 1, 'invalid json reported');
  }],
  ['opml: parent is section, leaf is album', () => {
    const r = importText('a.opml', '<opml><body><outline text="Punk"><outline text="Ramones - Ramones (1976)"/><outline text="junk"/></outline></body></opml>');
    eq(r.albums.length, 1, 'count'); eq(r.albums[0].section, 'PUNK', 'section'); eq(r.skipped.length, 1, 'skipped');
  }],
  ['export then re-import round-trips ids', () => {
    const src = importText('a.md', '## ROCK\n- [x] Pixies - Doolittle (1989)\n- Sigur Rós - Ágætis byrjun (1999)').albums, own = (a) => a.mdOwned;
    for (const [name, text] of [['a.md', toMarkdown(src, own)], ['a.csv', toCsv(src, own)], ['a.json', toJson(src, own)]])
      eq(importText(name, text).albums.map((a) => a.id), src.map((a) => a.id), name);
  }],
  ['merge adds only unseen ids; replace swaps', () => {
    const a = [{ id: '1' }, { id: '2' }], b = [{ id: '2' }, { id: '3' }];
    eq(applyImport(a, b, 'merge').albums.map((x) => x.id), ['1', '2', '3'], 'merge'); eq(applyImport(a, b, 'replace').albums.length, 2, 'replace');
  }],
  ['oversize input rejected', () => { let hit = false; try { importText('a.txt', 'x'.repeat(8 * 1024 * 1024 + 1)); } catch { hit = true; } if (!hit) throw new Error('accepted'); }],
  ['share links normalise', () => {
    eq(normalizeShareUrl('https://github.com/u/r/blob/main/a.md').url, 'https://raw.githubusercontent.com/u/r/main/a.md', 'github');
    eq(normalizeShareUrl('https://gist.github.com/u/abc123').url, 'https://gist.githubusercontent.com/u/abc123/raw', 'gist');
    eq(normalizeShareUrl('https://drive.google.com/file/d/XYZ/view').cors, 'unlikely', 'drive');
    eq(normalizeShareUrl('http://x.com/a').error !== undefined, true, 'http rejected');
  }],
  ['MEGA and Box links are rejected with a redirect to a readable host', () => {
    const mega = normalizeShareUrl('https://mega.nz/file/abc123#key');
    eq(mega.unsupported, 'mega', 'mega flagged'); eq(typeof mega.error, 'string', 'mega has reason'); eq(mega.url, undefined, 'mega no url');
    const megaOld = normalizeShareUrl('https://mega.co.nz/#!abc!key');
    eq(megaOld.unsupported, 'mega', 'legacy mega flagged');
    const box = normalizeShareUrl('https://app.box.com/s/abcdefg');
    eq(box.unsupported, 'box', 'box flagged'); eq(typeof box.error, 'string', 'box has reason');
    const boxEnterprise = normalizeShareUrl('https://acme.app.box.com/s/abcdefg');
    eq(boxEnterprise.unsupported, 'box', 'enterprise box flagged');
  }],
  ['diffAlbums finds added, removed and changed by id; unchanged ones are left alone', () => {
    const before = [
      { id: 'a', artist: 'A', title: 'A1', year: 2000, section: 'ROCK' },
      { id: 'b', artist: 'B', title: 'B1', year: 2001, section: 'ROCK' },
    ];
    const after = [
      { id: 'a', artist: 'A', title: 'A1', year: 2000, section: 'ROCK' },
      { id: 'b', artist: 'B', title: 'B1', year: 2002, section: 'ROCK' },
      { id: 'c', artist: 'C', title: 'C1', year: 2003, section: 'JAZZ' },
    ];
    const d = diffAlbums(before, after);
    eq(d.added.map((a) => a.id), ['c'], 'added');
    eq(d.removed, [], 'removed');
    eq(d.changed.length, 1, 'changed count'); eq(d.changed[0].id, 'b', 'changed id'); eq(d.changed[0].fields, ['year'], 'changed fields');
    eq(d.unchanged, 1, 'unchanged count');
    eq(hasDiff(d), true, 'hasDiff true'); eq(summarize(d), '+1, -0, ~1', 'summary');
    eq(hasDiff(diffAlbums(before, before)), false, 'no diff on identical lists');
  }],
  ['diffAlbums reports a pure removal', () => {
    const before = [{ id: 'a', artist: 'A', title: 'A1', year: 2000 }, { id: 'b', artist: 'B', title: 'B1', year: 2001 }];
    const after = [{ id: 'a', artist: 'A', title: 'A1', year: 2000 }];
    const d = diffAlbums(before, after);
    eq(d.removed.map((a) => a.id), ['b'], 'removed'); eq(d.added, [], 'added'); eq(summarize(d), '+0, -1, ~0', 'summary');
  }],
  ['CSV notes column reaches tableToAlbums, and mergeImportedNotes persists it without clobbering a user note', async () => {
    const { mergeImportedNotes, getNote, setNote } = await import('../js/ui/notes.js');
    const r = importText('a.csv', 'Artist,Album,Notes\nPixies,Doolittle,"Side B is the best part"\nWeezer,Weezer,');
    eq(r.albums[0].notes, 'Side B is the best part', 'notes column parsed onto the album');
    eq('notes' in r.albums[1], false, 'blank notes cell leaves no notes field');
    const added = mergeImportedNotes(r.albums);
    eq(added, 1, 'one note merged');
    eq(getNote(r.albums[0].id), 'Side B is the best part', 'merged note is readable back');
    setNote(r.albums[0].id, 'My own words');
    const reAdded = mergeImportedNotes(r.albums);
    eq(reAdded, 0, 'a re-import never overwrites a note the user already wrote');
    eq(getNote(r.albums[0].id), 'My own words', 'user note survives a re-import');
  }],
  ['splitDualTitle: plain title, slash form, parenthetical form, and no-split passthrough', () => {
    eq(splitDualTitle('Doolittle'), ['Doolittle'], 'plain title unchanged');
    eq(splitDualTitle('さよならポニーテール / Goodbye Ponytail'), ['Goodbye Ponytail', 'さよならポニーテール'], 'slash form: Latin candidate first');
    eq(splitDualTitle('さよならポニーテール (Goodbye Ponytail)'), ['Goodbye Ponytail', 'さよならポニーテール'], 'parenthetical form: Latin candidate first');
    eq(splitDualTitle('Kind of Blue (Legacy Edition)'), ['Kind of Blue (Legacy Edition)'], 'both-Latin parenthetical left as one candidate (edition tag, not a dual title)');
    eq(splitDualTitle(''), [''], 'empty string handled');
  }],
  ['pickByPriority: lowest priority value wins; ties keep the earliest (FIFO), confirming on-screen-before-off-screen ordering survives dual-title lookups', () => {
    const q = [{ priority: PRIORITY.idle }, { priority: PRIORITY.visible }, { priority: PRIORITY.near }];
    eq(q[pickByPriority(q)].priority, PRIORITY.visible, 'visible (1) beats near (2) and idle (3)');
    const tie = [{ priority: 1, tag: 'first' }, { priority: 1, tag: 'second' }];
    eq(tie[pickByPriority(tie)].tag, 'first', 'tie keeps the earliest-queued item');
  }],
  ['detectKeyProvider: known prefixes map to their provider; unknown/ambiguous shapes return null', () => {
    eq(detectKeyProvider('sk-ant-abc123'), 'anthropic', 'anthropic');
    eq(detectKeyProvider('sk-or-v1-abc123'), 'openrouter', 'openrouter checked before generic sk-');
    eq(detectKeyProvider('xai-abc123'), 'xai', 'xai');
    eq(detectKeyProvider('gsk_abc123'), 'groq', 'groq');
    eq(detectKeyProvider('AIzaSyAbc123'), 'gemini', 'gemini');
    eq(detectKeyProvider('sk-proj-abc123def456'), 'openai', 'openai project key');
    eq(detectKeyProvider('sk-abcdefghijklmnopqrstuvwxyz'), 'openai', 'openai classic key');
    eq(detectKeyProvider('plain-opaque-token-123'), null, 'unrecognised shape: ambiguous, falls back to manual picker');
    eq(detectKeyProvider(''), null, 'empty key');
  }],
  ['checkSynopsis: rejects truncated/wrong-count text, accepts 2-3 complete sentences; synopsisStub never truncates', () => {
    eq(checkSynopsis('A moody, atmospheric debut that leans into reverb-soaked guitars.').ok, false, 'single sentence rejected (needs 2-3)');
    eq(checkSynopsis('A moody debut. It leans into reverb-soaked guitars and hushed vocals').ok, false, 'no terminal punctuation: truncated');
    const ok = checkSynopsis('A moody, atmospheric debut. It leans into reverb-soaked guitars and hushed vocals. The mood stays restrained throughout.');
    eq(ok.ok, true, '3 complete sentences accepted');
    eq(checkSynopsis('').ok, false, 'empty rejected');
    eq(synopsisStub({ artist: 'Pixies', section: 'ROCK', year: 1989 }), 'Pixies — ROCK, 1989.', 'stub is a complete sentence');
    eq(synopsisStub({ artist: 'Unknown Artist' }), 'Unknown Artist album.', 'stub with no genre/year still complete');
  }],
  ['pickAutoFile: prefers the most recently modified .md/.txt candidate; all candidates still returned for a picker; ties/missing dates keep listing order', () => {
    const entries = [
      { name: 'README.md', modifiedAt: 5000 },
      { name: 'notes.txt', modifiedAt: 9000 },
      { name: 'cover.png', modifiedAt: 99999 },
      { name: 'albums.md', modifiedAt: 7000 },
    ];
    const { best, all } = pickAutoFile(entries);
    eq(best.name, 'notes.txt', 'most recently modified candidate wins, non-md/txt files excluded');
    eq(all.map((e) => e.name), ['README.md', 'notes.txt', 'albums.md'], 'every candidate surfaced for a picker, non-candidates excluded');
    eq(pickAutoFile([{ name: 'a.md', modifiedAt: null }, { name: 'b.md', modifiedAt: null }]).best.name, 'a.md', 'all-null dates: first in listing order wins');
    eq(pickAutoFile([{ name: 'a.md', modifiedAt: null }, { name: 'b.md', modifiedAt: 1 }]).best.name, 'b.md', 'a known date beats an unknown one');
    eq(pickAutoFile([]).best, null, 'empty listing: no auto-pick');
  }],
  ['shouldSkipDefaultLoad: boot() skips its default fetch exactly when extras.js would own the load', async () => {
    const { shouldSkipDefaultLoad } = await import('../js/store/source-gate.js');
    eq(shouldSkipDefaultLoad('', '', ''), false, 'no cloud url, no provider, no src: boot() loads albums.md itself');
    eq(shouldSkipDefaultLoad('', '', null), false, 'null src (no ?src= param) behaves like empty');
    eq(shouldSkipDefaultLoad('https://example.com/a.md', '', ''), true, 'saved crate.cloud url defers to extras.js');
    eq(shouldSkipDefaultLoad('', 'dropbox', ''), true, 'saved crate.cloud.provider defers to extras.js');
    eq(shouldSkipDefaultLoad('', '', 'https://example.com/a.md'), true, '?src= pointing at https defers to extras.js');
    eq(shouldSkipDefaultLoad('', '', 'albums.md'), false, 'a plain relative ?src= is still the local default path');
    eq(shouldSkipDefaultLoad('', '', 'http://example.com/a.md'), false, 'plain http (not https) is not treated as a cloud source');
  }],
  ['createCoverService: a jump-priority (sheet-open) request preempts a slower background fetch instead of queueing behind it', async () => {
    // Every concurrency slot (2, to keep the test small) is filled with a provider that never resolves on
    // its own — only an abort ends it. A third, jump-priority want() then arrives for a different album.
    // Without preemption this hangs until the 400ms test timeout below; with it, the hung slot is aborted
    // and the jump request's own (fast) provider answers almost immediately.
    // Every album except 'clicked' hangs forever on this provider (only an abort ends it); 'clicked'
    // resolves immediately, standing in for a real provider answering a real network request.
    const hangers = [];
    const provider = { name: 'mixed', limiter: { isOpen: () => false, acquire: async () => {}, success() {}, failure() {} },
      find: (album, signal) => {
        if (album.id === 'clicked') return Promise.resolve([{ title: album.title, artist: album.artist, url: 'https://example.com/cover.jpg' }]);
        return new Promise((resolve, reject) => { hangers.push(album.id); signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
      } };
    const memCache = new Map();
    const cache = { get: async (id) => memCache.get(id) ?? null, putHit: async (e) => memCache.set(e.id, { url: e.url }), putMiss: async () => {}, peek: () => null, put: () => {}, clearMisses: () => {} };
    const svc = createCoverService({ providers: [provider], cache, concurrency: 2, timeoutMs: 60000 });
    svc.want({ id: 'bg-1', title: 'bg-1', artist: 'x' }, () => {}, PRIORITY.visible);
    svc.want({ id: 'bg-2', title: 'bg-2', artist: 'x' }, () => {}, PRIORITY.visible);
    await new Promise((r) => setTimeout(r, 10)); // let pump() actually start both (run() is async)
    eq(hangers.length, 2, 'both background requests actually started (occupying both concurrency slots)');
    const jumpResult = await Promise.race([
      new Promise((resolve) => svc.want({ id: 'clicked', title: 'clicked', artist: 'x' }, resolve, PRIORITY.jump)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('jump request never got a slot (no preemption)')), 400)),
    ]);
    eq(jumpResult, 'https://example.com/cover.jpg', 'the clicked album\'s own cover resolves even though both slots were full of hung background requests');
  }],
];
