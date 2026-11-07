import { normalize, cleanTitle, bestMatch, scoreCandidate } from '../js/covers/matcher.js';
import { createLimiter } from '../js/covers/limiter.js';

const album = (artist, title, year) => ({ artist, title, year });
const cand = (artist, title, year) => ({ artist, title, year, url: 'u' });

export const cases = [
  ['normalize folds accents, ampersand, leading The', () => {
    if (normalize('Sigur Rós') !== 'sigur ros') throw new Error(normalize('Sigur Rós'));
    if (normalize('The Beatles & Co') !== 'beatles and co') throw new Error('amp');
  }],
  ['cleanTitle drops edition words and bracketed tags', () => {
    if (cleanTitle('Abbey Road (Remastered 2009)') !== 'abbey road') throw new Error(cleanTitle('Abbey Road (Remastered 2009)'));
    if (cleanTitle('Kind of Blue - Legacy Edition') !== 'kind of blue legacy') throw new Error(cleanTitle('Kind of Blue - Legacy Edition'));
  }],
  ['exact album with remaster tag matches', () => {
    const m = bestMatch(album('The Beatles', 'Abbey Road', 1969), [cand('The Beatles', 'Abbey Road (Remastered)', 1969)]);
    if (!m || m.score < 0.9) throw new Error(JSON.stringify(m));
  }],
  ['live album is rejected for a studio request', () => {
    const m = bestMatch(album('Nirvana', 'Nevermind', 1991), [cand('Nirvana', 'Nevermind Live', 1991)]);
    if (m) throw new Error('accepted ' + m.title);
  }],
  ['live album accepted when title asks for live', () => {
    if (!bestMatch(album('Nirvana', 'Unplugged in New York', 1994), [cand('Nirvana', 'MTV Unplugged in New York', 1994)])) throw new Error('rejected');
  }],
  ['same title, wrong artist is rejected', () => {
    if (bestMatch(album('Weezer', 'Weezer', 1994), [cand('Taylor Swift', 'Weezer', 1994)])) throw new Error('accepted');
  }],
  ['self-titled and Various Artists match', () => {
    if (!bestMatch(album('Weezer', 'Weezer', 1994), [cand('Weezer', 'Weezer (Blue Album)', 1994)])) throw new Error('self-titled');
    if (!bestMatch(album('Various Artists', 'Pulp Fiction', 1994), [cand('Various Artists', 'Pulp Fiction', 1994)])) throw new Error('VA');
  }],
  ['year gap lowers score', () => {
    const a = album('Pixies', 'Doolittle', 1989);
    if (scoreCandidate(a, cand('Pixies', 'Doolittle', 1989)).score <= scoreCandidate(a, cand('Pixies', 'Doolittle', 2009)).score) throw new Error('no penalty');
  }],
  ['limiter paces tokens and opens circuit after 3 failures', async () => {
    const l = createLimiter({ ratePerSec: 20, burst: 1, failThreshold: 3, cooldownMs: 1000 });
    const t0 = performance.now();
    await l.acquire(); await l.acquire(); await l.acquire();
    if (performance.now() - t0 < 80) throw new Error('not paced');
    l.failure(); l.failure(); if (l.isOpen()) throw new Error('opened early');
    l.failure(); if (!l.isOpen()) throw new Error('did not open');
  }],
];

import { createCoverCache } from '../js/covers/cache.js';
cases.push(
  ['pinned user cover stays fresh and survives clearMisses; misses are returned for undo', async () => {
    const c = createCoverCache('t-' + Math.random());
    c.put({ id: 'u', url: 'https://x/y.jpg', provider: 'user', pinned: true, fetchedAt: 0, score: 1, misses: 0, retryAt: 0 });
    await c.putMiss('m');
    const removed = await c.clearMisses();
    if (removed.length !== 1 || removed[0].id !== 'm') throw new Error('removed ' + JSON.stringify(removed.map((e) => e.id)));
    if (!(await c.get('u'))) throw new Error('pinned entry went stale');
    if (await c.get('m')) throw new Error('miss still cached');
  }],
  ['miss backoff escalates and a hit replaces a miss', async () => {
    const c = createCoverCache('t-' + Math.random());
    await c.putMiss('a'); const first = await c.peek('a');
    await c.putMiss('a'); const second = await c.peek('a');
    if (second.misses !== 2 || second.retryAt - second.fetchedAt <= first.retryAt - first.fetchedAt) throw new Error('no escalation');
    c.putHit({ id: 'a', url: 'u', provider: 'itunes', score: 0.9 });
    if ((await c.get('a'))?.url !== 'u') throw new Error('hit not stored');
  }],
);
