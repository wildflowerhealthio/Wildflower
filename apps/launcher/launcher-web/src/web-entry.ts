import {
  arrivingSmartLaunchFrom,
  normalizeServerUrl,
  searchWithoutAuthorizationResponse,
  searchWithServerUrl,
  serverUrlFromSearch,
} from '@wildflowerhealthio/authorization-core/smart-client'
import {
  type BearerAuthStateStore,
  authorizationLogoutSettingsItem,
} from '@wildflowerhealthio/authorization-react'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import { Option } from 'effect'

import type { EhrLaunch } from './sign-in.ts'

/**
 * The `sessionStorage` key holding the server this tab last signed in to.
 *
 * The settled URL after a sign-in names no server (see `postSignInUrl`), so a
 * reload, or the expiry bounce back to the landing, would otherwise have
 * forgotten which server the tab was using. A sign-in writes it with the
 * bearer (`BearerAuthStateStore.writeSession`) and logout clears it. It holds
 * no credential, and is namespaced like the pending record because the
 * server-docs console shares this origin.
 */
const SIGNED_IN_SERVER_KEY = 'launcher-web.signed-in-server'

/** Where the session's server is kept: `window.sessionStorage` in the browser. */
type SignedInServerStore = Pick<Storage, 'getItem'>

/**
 * The server the landing page signs in to without asking the reader: the one
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
 * own, but a write straight to the history object or the location does not, so
 * the logout's reload of `/` on a build served under a PR preview's
 * `/staging/pr-<n>/launcher/` would land at the origin root, off the app. `basepath`
 * is the slash-suffixed served directory (`basenameOf(location.pathname)`); at
 * the origin root it is `/`, and the prefix is a no-op.
 *
 * @example underBasepath('/staging/pr-7/launcher/', '/home') // '/staging/pr-7/launcher/home'
 * @example underBasepath('/', '/home') // '/home'
 */
const underBasepath = (basepath: string, route: string): string =>
  `${basepath.replace(/\/$/, '')}${route}`

/**
 * The settings screen's Logout row: the authorization server's, over `bearerStore`. It
 * forgets the bearer, revokes it at the session's server's `/authorization/logout`,
 * clears the tab's `sessionStorage` (the session's server and any
 * half-finished sign-in's pending record), and reloads the bare landing page
 * at `basepath`. Nothing then names a server, so the reader picks one rather
 * than being signed straight back in.
 *
 * `page` is the slice of `window` the row navigates; a real `Window`
 * satisfies it, and a test passes a stub.
 */
const logoutSettingsItem = (
  page: {
    readonly fetch: typeof globalThis.fetch
    readonly location: Pick<Location, 'assign'>
    readonly sessionStorage: Pick<Storage, 'clear'>
  },
  basepath: string,
  bearerStore: BearerAuthStateStore
): SettingsItem =>
  authorizationLogoutSettingsItem({
    bearerStore,
    fetch: (input, init) => page.fetch(input, init),
    leave: () => {
      page.sessionStorage.clear()
      page.location.assign(underBasepath(basepath, '/'))
    },
  })

export {
  chosenServerUrl,
  ehrLaunchIn,
  logoutSettingsItem,
  searchAfterReturnLeg,
  SIGNED_IN_SERVER_KEY,
  underBasepath,
}
export type { SignedInServerStore }
