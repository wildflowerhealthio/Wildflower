import { serverUrlFromSearch } from 'gatekeeper-core/smart-client'
import {
  makeAwaitLandingAuthReady,
  makeBearerAuthStateStore,
  type BearerAuthStateStore,
} from 'gatekeeper-react'
// Named imports, not the whole document: only these two fields concern this
// entry, and importing them individually keeps the rest of the host's
// configuration out of a published bundle. The same read
// `apps/wildflower-server-docs/src/host-defaults.ts` does, and the same one
// `apps/wildflower-tauri/vite.config.ts` injects `WILDFLOWER_LOOPBACK_ORIGIN`
// from.
import {
  loopback_hostname as loopbackHostname,
  loopback_port as loopbackPort,
} from '../../wildflower-tauri/tauri-shared-config.json'

import type { RenderAppOptions } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'

/**
 * The API origin assumed when the URL carries no usable `?server=`: the loopback
 * origin a locally-running Wildflower server binds, read from the same
 * `tauri-shared-config.json` the Rust host and the Tauri webview derive theirs
 * from, so this page cannot carry a stale copy of it.
 *
 * Exported because the landing page's "local server" button and its sign-in both
 * need the same value the transport resolves — a second literal there would let
 * the page sign in to one server and send its requests to another.
 */
const DEFAULT_SERVER_URL = `http://${loopbackHostname}:${loopbackPort}`

/**
 * The API origin a page load targets, given its `location.search`. Falls back to
 * {@link DEFAULT_SERVER_URL} when the parameter is absent, empty or rejected as
 * unusable — the same shape `apps/wildflower-server-docs/src/server-target.ts`
 * gives the console.
 */
const apiServerUrl = (search: string): string => serverUrlFromSearch(search) ?? DEFAULT_SERVER_URL

/**
 * `renderApp` wiring for `main-web` — the build served from static hosting,
 * which runs **cross-origin** to whichever API server `?server=` names.
 *
 * That origin is the whole difference from `main-single-web` (see
 * `single-web-entry.ts`). Cross-origin means the `HttpOnly` `wf_auth` cookie is
 * never carried (it is `SameSite=Lax`), so this entry holds a bearer in page
 * memory and attaches it itself; the single-web bundle is served by the API
 * server and rides the cookie instead.
 *
 * - `tokenStore`: in-memory bearer via `makeBearerAuthStateStore()`.
 *   A page reload returns to `Unauthed` (the bearer is in memory only).
 * - `awaitAuthReady`: redirects unauthed users to the root landing
 *   page (`/`) instead of device-login, because this entry has no API server
 *   until the reader picks one — the picker and the sign-in live at the root.
 * - `apiBaseUrl`: read from `?server=`, defaulting to the local
 *   loopback origin.
 * - `readBearer`: wired to the store's `bearer()` reader, so
 *   every relative request gets an `Authorization` header.
 * - `makeTransport`: pre-resolved stub (no host bridge).
 * - `platformSettingsItems`: none — the logout row posts a same-origin
 *   `POST /access/logout`, which does nothing for a page holding a bearer.
 * - `platformTabs`: none.
 * - `redirectToDeviceLoginOnUnauthorized`: true — a 401 that outlives the
 *   boot-race retry still falls back to the device-code screen. The landing
 *   page signs in by SMART redirect instead (`sign-in.ts`), so that route is
 *   reached only from this fallback and from a step-up, not from the picker.
 */
const makeWebEntryOptions = (): Pick<
  RenderAppOptions,
  | 'tokenStore'
  | 'awaitAuthReady'
  | 'makeTransport'
  | 'apiBaseUrl'
  | 'readBearer'
  | 'platformSettingsItems'
  | 'platformTabs'
  | 'redirectToDeviceLoginOnUnauthorized'
> & { readonly bearerStore: BearerAuthStateStore } => {
  const bearerStore = makeBearerAuthStateStore()

  const apiBaseUrl = apiServerUrl(window.location.search)

  return {
    bearerStore,
    tokenStore: bearerStore,
    awaitAuthReady: () => makeAwaitLandingAuthReady(bearerStore.subscribable),
    makeTransport: () => Promise.resolve(stubTransport),
    apiBaseUrl,
    readBearer: bearerStore.bearer,
    platformSettingsItems: [],
    platformTabs: [],
    redirectToDeviceLoginOnUnauthorized: true,
  }
}

export { apiServerUrl, DEFAULT_SERVER_URL, makeWebEntryOptions }
