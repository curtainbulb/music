const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const id = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(id); reject(signal.reason); };
  if (signal?.aborted) return onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Token bucket plus circuit breaker. failure() x failThreshold opens the circuit for cooldownMs. */
export function createLimiter({ ratePerSec, burst = 1, failThreshold = 3, cooldownMs = 60000 }) {
  let tokens = burst, last = performance.now(), fails = 0, openUntil = 0;
  const refill = () => {
    const now = performance.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSec);
    last = now;
  };
  return {
    isOpen: () => performance.now() < openUntil,
    async acquire(signal) {
      for (;;) {
        refill();
        if (tokens >= 1) { tokens -= 1; return; }
        await sleep(((1 - tokens) / ratePerSec) * 1000, signal);
      }
    },
    success() { fails = 0; },
    failure() { if (++fails >= failThreshold) { openUntil = performance.now() + cooldownMs; fails = 0; } },
  };
}
