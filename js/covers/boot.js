import { createProviders, resizeCover } from './providers.js';
import { createCoverCache } from './cache.js';
import { createCoverService } from './service.js';

export { resizeCover };
/** getKey(name) is threaded through to the keyed providers (Last.fm, Discogs) so a key saved later in
 * the session is picked up on the next lookup without reloading the page. */
export const createCovers = (onChange, getKey) => createCoverService({ providers: createProviders(getKey), cache: createCoverCache(), onChange });
