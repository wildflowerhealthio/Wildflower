import type { BearerAuthStateStore } from 'gatekeeper-react'
import { Unauthed } from 'react-kitchen-sink'
import type { SettingsItem } from 'shared-structures-react'

/** What {@link logOutBearerSession} needs from `main-web`'s wiring. */
interface BearerLogoutDeps {
  /** The API server the page is signed in to — the `?server=` it runs against. */
  readonly apiBaseUrl: string
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
      await deps.fetch(`${deps.apiBaseUrl.replace(/\/+$/, '')}/access/logout`, {
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
 * `main-web`'s "Logout" settings row. An action row (`onClick`), not the
 * same-origin form `gatekeeper-react`'s `gatekeeperLogoutSettingsItem` posts:
 * this page runs cross-origin to its server and holds a bearer, not a cookie,
 * so a form post would carry no credential and clear nothing.
 */
const makeBearerLogoutSettingsItem = (deps: BearerLogoutDeps): SettingsItem => ({
  id: 'logout',
  title: 'Logout',
  subtitle: 'Log out of Wildflower and end this session.',
  onClick: () => {
    void logOutBearerSession(deps)
  },
})

export { logOutBearerSession, makeBearerLogoutSettingsItem }
export type { BearerLogoutDeps }
