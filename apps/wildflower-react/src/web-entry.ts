import { searchWithServerUrl, serverUrlFromSearch } from 'gatekeeper-core/smart-client'
import {
  gatekeeperLogoutSettingsItem,
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
import { clientBaseUrlFor } from './sign-in.ts'

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
 * Prefix a root-absolute in-app route with the served `basepath`, so a raw
 * `history.push`/`replace` lands where the router — configured with that same
 * `basepath` — will match it.
 *
 * A router navigation (`router.navigate`, `<Link>`) applies the basepath on its
 * own, but a write straight to the history object does not, so a device-login
 * return that pushes `/home` on a build served under `/app/` (or a PR preview's
 * `/staging/pr-<n>/app/`) would land at `<origin>/home`, off the app. `basepath`
 * is the slash-suffixed served directory (`basenameOf(location.pathname)`); at
 * the origin root it is `/`, and the prefix is a no-op.
 *
 * @example underBasepath('/staging/pr-7/app/', '/home') // '/staging/pr-7/app/home'
 * @example underBasepath('/', '/home') // '/home'
 */
const underBasepath = (basepath: string, route: string): string =>
  `${basepath.replace(/\/$/, '')}${route}`

/**
 * `renderApp` wiring for `main-web` — the build served from static hosting,
 * which runs **cross-origin** to whichever API server `?server=` names.
 *
 * Cross-origin means no host authenticates on this page's behalf, so this entry
 * holds a bearer in page memory and attaches it itself.
 *
 * - `tokenStore`: in-memory bearer via `makeBearerAuthStateStore()`.
 *   A page reload returns to `Unauthed` (the bearer is in memory only).
 * - `awaitAuthReady`: redirects unauthed users to the root landing
 *   page (`/`) instead of device-login, because this entry has no API server
 *   until the reader picks one — the picker and the sign-in live at the root.
 * - `apiBaseUrl`: read from `?server=`, defaulting to the local
 *   loopback origin.
 * - `clientBaseUrl`: this copy's served root (origin + `basepath`), named to
 *   the server on the device-flow request and the logout so the pages it hands
 *   back point at this copy — see `sign-in.ts`'s `clientBaseUrlFor`.
 * - `readBearer`: wired to the store's `bearer()` reader, so
 *   every relative request gets an `Authorization` header.
 * - `makeTransport`: pre-resolved stub (no host bridge).
 * - `platformSettingsItems`: gatekeeper's logout row (`gatekeeperLogoutSettingsItem`) —
 *   forgets the bearer, revokes it at `{server}/access/logout`, and reloads the
 *   landing page at `basepath`, still pointed at the same server.
 * - `platformTabs`: none.
 * - `redirectToDeviceLoginOnUnauthorized`: true — a 401 that outlives the
 *   boot-race retry still falls back to the device-code screen. The landing
 *   page signs in by SMART redirect instead (`sign-in.ts`), so that route is
 *   reached only from this fallback and from a step-up, not from the picker.
 */
const makeWebEntryOptions = (
  basepath: string
): Pick<
  RenderAppOptions,
  | 'tokenStore'
  | 'awaitAuthReady'
  | 'makeTransport'
  | 'apiBaseUrl'
  | 'clientBaseUrl'
  | 'readBearer'
  | 'platformSettingsItems'
  | 'platformTabs'
  | 'redirectToDeviceLoginOnUnauthorized'
> & { readonly bearerStore: BearerAuthStateStore } => {
  const bearerStore = makeBearerAuthStateStore()

  const apiBaseUrl = apiServerUrl(window.location.search)
  const clientBaseUrl = clientBaseUrlFor(window.location.href, basepath)

  return {
    bearerStore,
    tokenStore: bearerStore,
    awaitAuthReady: () => makeAwaitLandingAuthReady(bearerStore.subscribable),
    makeTransport: () => Promise.resolve(stubTransport),
    apiBaseUrl,
    ...(clientBaseUrl === undefined ? {} : { clientBaseUrl }),
    readBearer: bearerStore.bearer,
    platformSettingsItems: [
      gatekeeperLogoutSettingsItem({
        apiBaseUrl,
        ...(clientBaseUrl === undefined ? {} : { clientBaseUrl }),
        bearerStore,
        fetch: (input, init) => window.fetch(input, init),
        leave: () => {
          window.location.assign(
            `${underBasepath(basepath, '/')}${searchWithServerUrl('', apiBaseUrl)}`
          )
        },
      }),
    ],
    platformTabs: [],
    redirectToDeviceLoginOnUnauthorized: true,
  }
}

export { apiServerUrl, DEFAULT_SERVER_URL, makeWebEntryOptions, underBasepath }
