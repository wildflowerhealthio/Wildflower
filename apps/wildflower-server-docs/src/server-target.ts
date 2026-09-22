/**
 * This console's `?server=` default.
 *
 * The parsing itself belongs to every static Wildflower page that targets a
 * server the reader chooses, so it lives in
 * `gatekeeper-core/smart-client` (`normalizeServerUrl`, `searchWithServerUrl`,
 * `serverUrlFromSearch`). What stays here is the one thing that is this
 * console's alone: the target it assumes when the URL names none.
 */

import { serverUrlFromSearch as parseServerUrl } from 'gatekeeper-core/smart-client'

import { HOST_LOOPBACK_ORIGIN } from './host-defaults.ts'

/**
 * The target assumed when the URL carries no usable `?server=`: the loopback
 * origin the desktop host's embedded API server binds, read from the shared
 * Tauri config rather than restated here (see `host-defaults.ts`).
 */
const DEFAULT_SERVER_URL = HOST_LOOPBACK_ORIGIN

/**
 * The API origin a page load should target, given its `location.search`.
 * Falls back to {@link DEFAULT_SERVER_URL} when the parameter is absent, empty
 * or rejected as unusable.
 */
const serverUrlFromSearch = (search: string): string => parseServerUrl(search) ?? DEFAULT_SERVER_URL

export { DEFAULT_SERVER_URL, serverUrlFromSearch }
