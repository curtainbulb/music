import { lsGet, lsSet, lsDel, ssGet, ssSet, ssDel } from './local.js';

/**
 * Generic per-provider API key storage, shared by the AI providers (js/ai/smartpicks.js) and the keyed
 * cover providers (Last.fm, Discogs — js/covers/providers.js). A key is kept in sessionStorage by
 * default (gone when the tab closes) and only moved to localStorage when the user ticks "remember".
 * Keys are never logged and never placed in a URL.
 */
export const keyOf = (provider) => ssGet(`crate.key.${provider}`) || lsGet(`crate.key.${provider}`, '') || '';

export function saveKey(provider, key, remember) {
  ssDel(`crate.key.${provider}`);
  lsDel(`crate.key.${provider}`);
  if (!key) return;
  if (remember) lsSet(`crate.key.${provider}`, key);
  else ssSet(`crate.key.${provider}`, key);
}

export const keyRemembered = (provider) => !!lsGet(`crate.key.${provider}`, '');
