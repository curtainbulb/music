// Kept in its own module (no DOM access) so it can be unit-tested from Node — js/main.js has top-level
// DOM lookups and calls boot() on import, so it can't be imported directly in a test runner.

/** Pure decision: given the two localStorage values and the ?src= query param that both js/main.js's
 * boot() and js/ui/extras.js's initSource() read, should boot() skip its own default albums.md fetch?
 * Slice 3 flagged a same-session race where boot()'s default load could fire after an early cloud result
 * and clobber it; Slice 8 closed it by making extras.js the sole source of truth whenever a cloud source
 * is configured, using this same check on both sides. */
export const shouldSkipDefaultLoad = (cloud, cloudProvider, src) => !!(cloud || cloudProvider || /^https:/.test(src || ''));
