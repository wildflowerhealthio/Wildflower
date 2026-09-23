import { CLIENT_BASE_URL_PARAM } from 'gatekeeper-core/smart-client'
import { Unauthed } from 'react-kitchen-sink'
import type { SettingsItem } from 'shared-structures-react'
import type { BearerAuthStateStore } from './client/bearer-auth-state-store.ts'

/** What {@link logOutBearerSession} needs from the entry's wiring. */
interface BearerLogoutDeps {
  /** The API server the page is signed in to — the `?server=` it runs against. */
  readonly apiBaseUrl: string
  /**
   * This copy's served root (`sign-in.ts`'s `clientBaseUrlFor`), named on the
   * revoke so the server's `303` points back at this copy. Omitted when the
   * page has none to name.
   */
  readonly clientBaseUrl?: string
  /** The page's bearer store: read for the token to revoke, then emptied. */
  readonly bearerStore: Pick<BearerAuthStateStore, 'bearer' | 'setAuthState'>
  /** `window.fetch`, injected so a test can observe the revoke request. */
  readonly fetch: typeof fetch
  /**
   * Leave for the landing page. A full page load rather than a router
   * navigation, so nothing the signed-in session cached (TanStack Query's
   * owner data, in-flight streams) outlives the logout.
   */
  readonly leave: () => void
}

/** `POST {server}/access/logout`, naming this copy's served root when it has one. */
const logoutUrl = (deps: Pick<BearerLogoutDeps, 'apiBaseUrl' | 'clientBaseUrl'>): string => {
  const url = `${deps.apiBaseUrl.replace(/\/+$/, '')}/access/logout`
  if (deps.clientBaseUrl === undefined) return url
  return `${url}?${new URLSearchParams({ [CLIENT_BASE_URL_PARAM]: deps.clientBaseUrl }).toString()}`
}

/**
 * End `main-web`'s session: forget the bearer, ask the server to revoke it, and
 * go back to the landing page.
 *
 * @remarks
 * Forgetting the in-memory bearer is the logout that matters, so it runs first
 * and can't fail. Revoking at `POST {server}/access/logout` (which denylists
 * the token's `jti`) is best-effort defence in depth. `redirect: 'manual'`
 * stops `fetch` following the endpoint's `303` to the owner UI's root (`leave`
 * owns the navigation); `keepalive` lets the revoke outlive `leave` unloading
 * the page.
 */
const logOutBearerSession = async (deps: BearerLogoutDeps): Promise<void> => {
  const bearer = deps.bearerStore.bearer()
  deps.bearerStore.setAuthState(Unauthed())
  if (bearer !== undefined) {
    try {
      await deps.fetch(logoutUrl(deps), {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        redirect: 'manual',
        keepalive: true,
      })
    } catch {
      // Best-effort — see above. The page is already logged out.
    }
  }
  deps.leave()
}

/**
 * Gatekeeper's "Logout" settings row, for an entry that holds a bearer
 * (`main-web`). An action row (`onClick`): logging out purges the page's
 * in-memory bearer and invalidates it server-side (`POST /access/logout`
 * revokes its `jti`) — see {@link logOutBearerSession}.
 */
const gatekeeperLogoutSettingsItem = (deps: BearerLogoutDeps): SettingsItem => ({
  id: 'logout',
  title: 'Logout',
  subtitle: 'Log out of Wildflower and end this session.',
  onClick: () => {
    void logOutBearerSession(deps)
  },
})

export { logOutBearerSession, gatekeeperLogoutSettingsItem }
export type { BearerLogoutDeps }
