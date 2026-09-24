import { normalizeServerUrl, serverUrlFromSearch } from 'gatekeeper-core/smart-client'
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
 * The `sessionStorage` key holding the server this tab last signed in to.
 *
 * The settled URL after a sign-in names no server (see `postSignInUrl`), so a
 * reload, or the expiry bounce back to the landing, would otherwise have
 * forgotten which server the tab was using. `main-web`'s boot writes it when a
 * sign-in is redeemed and logout clears it. It holds no credential, and is
 * namespaced like the pending record because the server-docs console shares
 * this origin.
 */
const SIGNED_IN_SERVER_KEY = 'wildflower-react.signed-in-server'

/** Where the signed-in server is kept: `window.sessionStorage` in the browser. */
type SignedInServerStore = Pick<Storage, 'getItem' | 'setItem' | 'clear'>

/** Record `serverUrl` as the server this tab is signed in to. */
const rememberSignedInServer = (store: SignedInServerStore, serverUrl: string): void => {
  store.setItem(SIGNED_IN_SERVER_KEY, serverUrl)
}

/**
 * The server this page load is pointed at without asking the reader: the one
 * `search`'s `?server=` names, else the one this tab last signed in to.
 * `undefined` when neither names a server this page would accept.
 */
const chosenServerUrl = (search: string, store: SignedInServerStore): string | undefined => {
  const fromSearch = serverUrlFromSearch(search)
  if (fromSearch !== undefined) return fromSearch
  const stored = store.getItem(SIGNED_IN_SERVER_KEY)
  return stored === null ? undefined : normalizeServerUrl(stored)
}

/**
 * The API origin a page load targets: the {@link chosenServerUrl}, falling back
 * to {@link DEFAULT_SERVER_URL} — the same shape
 * `apps/wildflower-server-docs/src/server-target.ts` gives the console.
 */
const apiServerUrl = (search: string, store: SignedInServerStore): string =>
  chosenServerUrl(search, store) ?? DEFAULT_SERVER_URL

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
 * - `apiBaseUrl`: the caller's `apiBaseUrl`, which `main-web` resolves with
 *   {@link apiServerUrl}. Past sign-in the address bar no longer names the
 *   server; the tab's remembered one does.
 * - `externalLinkRoot`: the page's own origin, which is an address another
 *   device can open.
 * - `readBearer`: wired to the store's `bearer()` reader, so
 *   every relative request gets an `Authorization` header.
 * - `makeTransport`: pre-resolved stub (no host bridge).
 * - `platformSettingsItems`: gatekeeper's logout row (`gatekeeperLogoutSettingsItem`) —
 *   forgets the bearer, revokes it at `{server}/access/logout`, clears the
 *   tab's `sessionStorage` (the signed-in server included), and reloads the
 *   bare landing page at `basepath`.
 *   Nothing then names a server, so the reader picks one rather than being
 *   signed straight back in.
 * - `platformTabs`: none.
 * - `redirectToDeviceLoginOnUnauthorized`: true — a 401 that outlives the
 *   boot-race retry still falls back to the device-code screen. The landing
 *   page signs in by SMART redirect instead (`sign-in.ts`), so that route is
 *   reached only from this fallback and from a step-up, not from the picker.
 *
 * `page` is the slice of `window` this wiring navigates; a real
 * `Window` satisfies it, and a test passes a stub.
 */
const makeWebEntryOptions = (
  page: {
    readonly fetch: typeof globalThis.fetch
    readonly location: Pick<Location, 'assign' | 'origin'>
    readonly sessionStorage: SignedInServerStore
  },
  basepath: string,
  apiBaseUrl: string
): Pick<
  RenderAppOptions,
  | 'tokenStore'
  | 'awaitAuthReady'
  | 'makeTransport'
  | 'apiBaseUrl'
  | 'externalLinkRoot'
  | 'readBearer'
  | 'platformSettingsItems'
  | 'platformTabs'
  | 'redirectToDeviceLoginOnUnauthorized'
> & { readonly bearerStore: BearerAuthStateStore } => {
  const bearerStore = makeBearerAuthStateStore()

  return {
    bearerStore,
    tokenStore: bearerStore,
    awaitAuthReady: () => makeAwaitLandingAuthReady(bearerStore.subscribable),
    makeTransport: () => Promise.resolve(stubTransport),
    apiBaseUrl,
    externalLinkRoot: () => page.location.origin,
    readBearer: bearerStore.bearer,
    platformSettingsItems: [
      gatekeeperLogoutSettingsItem({
        apiBaseUrl,
        bearerStore,
        fetch: (input, init) => page.fetch(input, init),
        leave: () => {
          // Everything this tab kept for the origin: the signed-in server and
          // any half-finished sign-in's pending record.
          page.sessionStorage.clear()
          page.location.assign(underBasepath(basepath, '/'))
        },
      }),
    ],
    platformTabs: [],
    redirectToDeviceLoginOnUnauthorized: true,
  }
}

export {
  apiServerUrl,
  chosenServerUrl,
  DEFAULT_SERVER_URL,
  makeWebEntryOptions,
  rememberSignedInServer,
  SIGNED_IN_SERVER_KEY,
  underBasepath,
}
export type { SignedInServerStore }
