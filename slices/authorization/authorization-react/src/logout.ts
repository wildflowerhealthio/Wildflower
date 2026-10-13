import { Unauthed } from '@wildflowerhealthio/react-kitchen-sink'
import type { SettingsItem } from '@wildflowerhealthio/shared-structures-react'
import type { BearerAuthStateStore } from './client/bearer-auth-state-store.ts'

/** What {@link logOutBearerSession} needs from the page's wiring. */
interface BearerLogoutDeps {
  /**
   * The page's bearer store: read for the token to revoke and the server that
   * issued it, then emptied.
   */
  readonly bearerStore: Pick<BearerAuthStateStore, 'serverUrl' | 'bearer' | 'setAuthState'>
  /** `window.fetch`, injected so a test can observe the revoke request. */
  readonly fetch: typeof fetch
  /**
   * Leave for the landing page. A full page load rather than a router
   * navigation, so nothing the signed-in session cached (TanStack Query's
   * owner data, in-flight streams) outlives the logout.
   */
  readonly leave: () => void
}

/**
 * End the launcher's session: forget the bearer, ask the server that issued it
 * to revoke it, and go back to the landing page.
 *
 * @remarks
 * Forgetting the in-memory bearer is the logout that matters, so it runs first
 * and can't fail. Revoking at `POST {server}/authorization/logout` (which denylists
 * the token's `jti`) is best-effort defence in depth. `redirect: 'manual'`
 * stops `fetch` following the endpoint's `303` to the launcher's root (`leave`
 * owns the navigation); `keepalive` lets the revoke outlive `leave` unloading
 * the page.
 */
const logOutBearerSession = async (deps: BearerLogoutDeps): Promise<void> => {
  const bearer = deps.bearerStore.bearer()
  const serverUrl = deps.bearerStore.serverUrl()
  deps.bearerStore.setAuthState(Unauthed())
  if (bearer !== undefined && serverUrl !== undefined) {
    try {
      await deps.fetch(`${serverUrl.replace(/\/+$/, '')}/authorization/logout`, {
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
 * The authorization server's "Logout" settings row, for a page that holds a bearer (the
 * launcher). An action row (`onClick`): logging out purges the page's
 * in-memory bearer and invalidates it server-side (`POST /authorization/logout`
 * revokes its `jti`) — see {@link logOutBearerSession}.
 */
const authorizationLogoutSettingsItem = (deps: BearerLogoutDeps): SettingsItem => ({
  id: 'logout',
  title: 'Logout',
  subtitle: 'Log out of Wildflower and end this session.',
  onClick: () => {
    void logOutBearerSession(deps)
  },
})

export { logOutBearerSession, authorizationLogoutSettingsItem }
export type { BearerLogoutDeps }
