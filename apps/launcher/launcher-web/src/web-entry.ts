import {
  arrivingSmartLaunchFrom,
  normalizeServerUrl,
  searchWithoutAuthorizationResponse,
  searchWithServerUrl,
  serverUrlFromSearch,
} from '@wildflowerhealthio/gatekeeper-core/smart-client'
import {
  gatekeeperLogoutSettingsItem,
  makeAwaitLandingAuthReady,
  makeBearerAuthStateStore,
  type BearerAuthStateStore,
} from '@wildflowerhealthio/gatekeeper-react'
import { Option } from 'effect'

import type { RenderAppOptions } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'
import type { EhrLaunch } from './sign-in.ts'

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
const SIGNED_IN_SERVER_KEY = 'launcher-web.signed-in-server'

/** Where the signed-in server is kept: `window.sessionStorage` in the browser. */
type SignedInServerStore = Pick<Storage, 'getItem' | 'setItem' | 'clear'>

/** Record `serverUrl` as the server this tab is signed in to. */
const rememberSignedInServer = (store: SignedInServerStore, serverUrl: string): void => {
  store.setItem(SIGNED_IN_SERVER_KEY, serverUrl)
}

/**
 * The server this page load is pointed at without asking the reader: the one
 * `search`'s `?server=` names, else the one this tab last signed in to.
 * `undefined` when neither names a server this page would accept: there is no
 * default server, so the reader picks one on the landing page.
 */
const chosenServerUrl = (search: string, store: SignedInServerStore): string | undefined => {
  const fromSearch = serverUrlFromSearch(search)
  if (fromSearch !== undefined) return fromSearch
  const stored = store.getItem(SIGNED_IN_SERVER_KEY)
  return stored === null ? undefined : normalizeServerUrl(stored)
}

/**
 * The {@link EhrLaunch} a page load arriving on `search` was opened with: the
 * SMART launch's `launch`, for the server its `iss` names. `undefined` when the
 * load carries no launch, when it is a standalone one (`iss` alone, a sign-in
 * to that server like any `?server=` one), and when `iss` names no usable
 * server.
 */
const ehrLaunchIn = (search: string): EhrLaunch | undefined =>
  Option.getOrUndefined(
    Option.flatMap(arrivingSmartLaunchFrom(search), ({ iss, launch }) => {
      const serverUrl = normalizeServerUrl(iss)
      return serverUrl === undefined || launch === undefined
        ? Option.none()
        : Option.some({ serverUrl, launch })
    })
  )

/**
 * The query a return leg settles on: the authorization response taken out
 * (`searchWithoutAuthorizationResponse`, which takes the authorization
 * server's RFC 9207 `iss` with it, so it never reads as a SMART launch) and,
 * when the sign-in failed and its pending record named the server it was to,
 * `?server=` pointed back at that server. The registered redirect carries no
 * query, so without it the landing would no longer offer the server the
 * reader was signing in to.
 */
const searchAfterReturnLeg = (
  returnSearch: string,
  failedServerUrl: string | undefined
): string => {
  const withoutResponse = searchWithoutAuthorizationResponse(returnSearch)
  return failedServerUrl === undefined
    ? withoutResponse
    : searchWithServerUrl(withoutResponse, failedServerUrl)
}

/**
 * Prefix a root-absolute in-app route with the served `basepath`, so a raw
 * `history.push`/`replace` lands where the router — configured with that same
 * `basepath` — will match it.
 *
 * A router navigation (`router.navigate`, `<Link>`) applies the basepath on its
 * own, but a write straight to the history object does not, so a device-login
 * return that pushes `/home` on a build served under `/launcher/` (or a PR preview's
 * `/staging/pr-<n>/launcher/`) would land at `<origin>/home`, off the app. `basepath`
 * is the slash-suffixed served directory (`basenameOf(location.pathname)`); at
 * the origin root it is `/`, and the prefix is a no-op.
 *
 * @example underBasepath('/staging/pr-7/launcher/', '/home') // '/staging/pr-7/launcher/home'
 * @example underBasepath('/', '/home') // '/home'
 */
const underBasepath = (basepath: string, route: string): string =>
  `${basepath.replace(/\/$/, '')}${route}`

/**
 * `buildAppTree` wiring for `main-web` — the build served from static hosting,
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
 *   {@link chosenServerUrl}. Past sign-in the address bar no longer names the
 *   server; the tab's remembered one does. `undefined` when no server is
 *   chosen yet: the page is then unauthed, and only its landing, which sends
 *   no API request, is reachable.
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
 *   signed straight back in. None without an `apiBaseUrl`: there is no
 *   server to revoke at, and a page with none is never signed in.
 * - `platformBanner`: none — no host runs a server for this page, so there is
 *   no server status to show.
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
  apiBaseUrl: string | undefined
): Pick<
  RenderAppOptions,
  | 'tokenStore'
  | 'awaitAuthReady'
  | 'makeTransport'
  | 'apiBaseUrl'
  | 'externalLinkRoot'
  | 'readBearer'
  | 'platformSettingsItems'
  | 'platformBanner'
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
    platformSettingsItems:
      apiBaseUrl === undefined
        ? []
        : [
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
    platformBanner: null,
    redirectToDeviceLoginOnUnauthorized: true,
  }
}

export {
  chosenServerUrl,
  ehrLaunchIn,
  makeWebEntryOptions,
  rememberSignedInServer,
  searchAfterReturnLeg,
  SIGNED_IN_SERVER_KEY,
  underBasepath,
}
export type { SignedInServerStore }
