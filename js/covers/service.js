import { bestMatch, scoreCandidate, splitDualTitle } from './matcher.js';

export const PRIORITY = { jump: 0, visible: 1, near: 2, idle: 3 };
const idleCallback = (fn) => (globalThis.requestIdleCallback ?? setTimeout)(fn);
const NEAR_MISS_FLOOR = 0.4; // below this a candidate is noise, not worth offering as a manual pick
const NEAR_MISS_CAP = 4; // product brief 3c: "up to 4 candidate images"
const nearMissCache = new Map(); // album.id -> [{title, artist, year, url, score}], most recent lookup only

/** Pure: index of the lowest-priority entry in queue (FIFO within a tie — first strictly-lower wins, an
 * equal priority never displaces an earlier item). Exported so tests/provider-cases.js can assert the
 * on-screen-before-off-screen ordering directly, without driving the whole async service. */
export function pickByPriority(queue) {
  let pick = -1;
  for (let i = 0; i < queue.length; i++) if (pick < 0 || queue[i].priority < queue[pick].priority) pick = i;
  return pick;
}

/**
 * want(album, cb, priority) calls cb(url | null) once, matching the old Art.want contract.
 * Transient failure (every provider errored) settles null WITHOUT caching a miss.
 * Needs AbortSignal.any / AbortSignal.timeout (Chrome 116+, Safari 17.4+, Firefox 124+).
 */
export function createCoverService({ providers, cache, concurrency = 5, threshold = 0.72, timeoutMs = 3500, onChange = () => {} }) {
  const waiters = new Map();
  let queue = [], active = 0, idleScheduled = false, idleOpen = false;
  const running = new Set(); // waiters currently in run(), for jump-priority preemption
  const stats = Object.fromEntries(providers.map((p) => [p.name, { hits: 0, misses: 0, errors: 0 }]));
  const emit = () => onChange({ queued: queue.length, active, stats });

  /** One title candidate against every provider; returns {url} on a confident hit, or null plus any
   * near-misses it saw (collected by the caller) when nothing cleared the threshold. */
  async function resolveCandidate(album, signal, nearMisses) {
    let answered = 0;
    for (const provider of providers) {
      if (provider.limiter.isOpen()) continue;
      try {
        await provider.limiter.acquire(signal);
        const callSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
        const cands = await provider.find(album, callSignal);
        provider.limiter.success();
        answered++;
        const best = bestMatch(album, cands, threshold);
        if (best) {
          stats[provider.name].hits++;
          return { url: best.url, score: best.score, provider: provider.name, answered };
        }
        stats[provider.name].misses++;
        for (const c of cands) {
          if (!c.url) continue;
          const s = scoreCandidate(album, c).score;
          if (s >= NEAR_MISS_FLOOR && s < threshold) nearMisses.push({ title: c.title, artist: c.artist, year: c.year, url: c.url, score: s, provider: provider.name });
        }
      } catch (err) {
        if (signal.aborted) throw err;
        provider.limiter.failure();
        stats[provider.name].errors++;
      }
    }
    return { url: null, answered };
  }

  /**
   * Dual-title poster parsing (brief item 3): split the album title into ordered candidates
   * (English/Latin first, foreign-script fallback) and query the full provider chain for each in turn,
   * stopping at the first confident match. A plain title with no dual-title pattern is a single candidate,
   * so this is a strict superset of the old single-lookup behaviour, not a second request per album in the
   * common case. Near-misses from every candidate tried are pooled (deduplicated by URL, best score kept,
   * capped at NEAR_MISS_CAP) and cached for the manual poster-choice modal (brief item 3c).
   */
  async function resolve(album, signal) {
    const cached = await cache.get(album.id);
    if (cached) return cached.url || null;
    const candidates = splitDualTitle(album.title);
    let answeredTotal = 0;
    const pooled = new Map(); // url -> entry, keeps the best score seen for that url
    for (const title of candidates) {
      const nearMisses = [];
      const titleAlbum = title === album.title ? album : { ...album, title };
      const res = await resolveCandidate(titleAlbum, signal, nearMisses);
      answeredTotal += res.answered;
      for (const nm of nearMisses) { const prev = pooled.get(nm.url); if (!prev || nm.score > prev.score) pooled.set(nm.url, nm); }
      if (res.url) {
        cache.putHit({ id: album.id, url: res.url, provider: res.provider, score: res.score });
        nearMissCache.delete(album.id);
        return res.url;
      }
    }
    if (pooled.size) {
      nearMissCache.set(album.id, [...pooled.values()].sort((a, b) => b.score - a.score).slice(0, NEAR_MISS_CAP));
    }
    if (answeredTotal) await cache.putMiss(album.id);
    return null;
  }

  /** Confirms the on-screen-before-off-screen priority queue is unaffected by dual-title lookups (brief
   * "recommended additions"): `resolve()` trying a second title candidate happens entirely INSIDE one
   * `run(w)` call for one already-dequeued waiter `w` — it does not add, re-queue or re-prioritize any
   * entry in `queue`. `takeNext()` still scans the same `queue` array and picks the lowest `priority`
   * value exactly as before; a second provider pass per album only makes that one `run()` call take longer
   * wall-clock time, which is already accounted for by `concurrency` (other queued items keep flowing
   * through the remaining slots). See tests/parser-cases.js for a Node test asserting takeNext() still
   * honours priority order. */
  function takeNext() {
    const pick = pickByPriority(queue);
    return pick < 0 ? null : queue.splice(pick, 1)[0];
  }

  const settle = (w, url) => { waiters.delete(w.album.id); for (const cb of w.cbs) cb(url); };

  async function run(w) {
    active++; running.add(w); w.controller = new AbortController(); emit();
    try { settle(w, await resolve(w.album, w.controller.signal)); }
    catch {
      // An abort from preemption (see pump()) is not a real miss: put w back in the queue instead of
      // settling it with null, unless unwant() already removed it from `waiters` (nothing left to serve).
      if (w.controller.signal.aborted) { if (waiters.has(w.album.id) && !queue.includes(w)) queue.push(w); }
      else settle(w, null);
    }
    finally { active--; running.delete(w); w.controller = null; emit(); pump(); }
  }

  /** The waiter among currently-running requests with the highest (worst) priority number, or null if
   * every running request already has priority <= maxPriority (nothing worth bumping). Ties go to
   * whichever running waiter was found first (Set iteration order = insertion order = oldest first), so a
   * preemption prefers interrupting the request that has had the longest head start on a background tier,
   * not the one that just started. */
  function worstRunning(maxPriority) {
    let found = null;
    for (const w of running) if (w.priority > maxPriority && (!found || w.priority > found.priority)) found = w;
    return found;
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const w = takeNext();
      if (w.priority === PRIORITY.idle && !idleOpen) {
        queue.push(w);
        if (!idleScheduled) { idleScheduled = true; idleCallback(() => { idleScheduled = false; idleOpen = true; pump(); idleOpen = false; }); }
        break;
      }
      run(w);
    }
    // A jump-priority (sheet-open) request waiting at the front of the queue with every concurrency slot
    // full of lower-priority background fetches would otherwise sit behind up to `concurrency` in-flight
    // timeouts before it even starts a network request. Preempt one: abort the longest-waiting worse-
    // priority running request so the jump request gets a slot immediately. The aborted request's own
    // provider loop treats this exactly like a timeout (resolve()'s catch path), settling its own waiters
    // with null rather than leaving them stuck — it will simply be re-queued and retried on the next pump
    // if it's still wanted (its callbacks are still registered; see want()/unwant()).
    if (active >= concurrency && queue.length) {
      const nextPick = pickByPriority(queue);
      if (queue[nextPick].priority === PRIORITY.jump) {
        const victim = worstRunning(PRIORITY.jump);
        if (victim) victim.controller?.abort();
      }
    }
  }

  return {
    stats,
    want(album, cb, priority = PRIORITY.visible) {
      let w = waiters.get(album.id);
      if (!w) { w = { album, cbs: new Set(), priority, controller: null }; waiters.set(album.id, w); }
      w.priority = Math.min(w.priority, priority);
      w.cbs.add(cb);
      if (!w.controller && !queue.includes(w)) queue.push(w);
      emit(); pump();
    },
    unwant(id, cb) {
      const w = waiters.get(id);
      if (!w) return;
      w.cbs.delete(cb);
      if (w.cbs.size) return;
      waiters.delete(id);
      queue = queue.filter((x) => x !== w);
      w.controller?.abort();
      emit();
    },
    markBad: (id) => cache.putMiss(id),
    /** Near-miss candidates (score >= NEAR_MISS_FLOOR but below the match threshold) from the most recent
     * failed lookup for this album, for the manual poster-choice modal (brief item 3c). Empty once a hit
     * is cached, since there's nothing left to choose between. */
    nearMisses: (id) => nearMissCache.get(id) ?? [],
    peek: (id) => cache.peek(id),
    restore: (entries) => entries.forEach((e) => cache.put(e)),
    setUser: async (id, { url = '', blob }) => cache.put({ id, url, blob, provider: 'user', score: 1, fetchedAt: Date.now(), pinned: true, misses: 0, retryAt: 0 }),
    retry: (id) => cache.del(id),
    clearMisses: () => cache.clearMisses(),
  };
}
