import {
  gatekeeperLogoutSettingsItem,
  makeAwaitWebAuthReady,
  makeWebAuthTokenStore,
} from 'gatekeeper-react'
import type { RenderAppOptions } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'

/**
 * Shared `renderApp` wiring for the standalone-web entries (`main-web`
 * and `main-single-web`), which differ only in `history`/`entry` and
 * their `instrument.ts` import — not in auth or transport behavior.
 *
 * Returns the environment-specific options both web entries share,
 * leaving each entry to spread them into its own `renderApp` call
 * alongside the platform extras. It's a factory, not a wrapper over
 * `renderApp`, so the entries keep their explicit `renderApp` call site
 * (and embedded stays untouched).
 *
 * - `tokenStore`: cookie-derived (the real JWT is the `HttpOnly` `wf_auth`
 *   cookie, invisible to JS; the store tracks the readable `wf_auth_exp`
 *   hint). Drives the auth-ready gate and the rotation invalidator. HTTP
 *   clients are tokenless — the cookie rides same-origin requests
 *   automatically, so no `Authorization` header is set.
 * - `awaitAuthReady`: ignores `transportReady` (standalone has no host
 *   handshake) and resolves against the store's subscribable — an authed
 *   signal resolves immediately, absent throws the device-login redirect.
 * - `makeTransport`: pre-resolved stub (no host bridge), so the `_auth`
 *   loader's `await context.transport` is a microtask. Both setters are
 *   ignored — there's no host to push `AuthTokenIssued` or
 *   `DeviceConsentRequested` from on standalone web.
 * - `platformSettingsItems`: the web logout row — a same-origin `POST
 *   /access/logout` form. Web-only: on Tauri the session is
 *   connection-provenance, so a cookie logout is a no-op.
 * - `makeOnUnauthorized`: standalone web HAS a device-login flow, so a 401 that
 *   outlives the boot-race retry redirects the user there.
 */
const makeWebEntryOptions = (): Pick<
  RenderAppOptions,
  'tokenStore' | 'awaitAuthReady' | 'makeTransport' | 'platformSettingsItems' | 'makeOnUnauthorized'
> => {
  const tokenStore = makeWebAuthTokenStore()
  return {
    tokenStore,
    awaitAuthReady: () => makeAwaitWebAuthReady(tokenStore.subscribable),
    makeTransport: () => Promise.resolve(stubTransport),
    platformSettingsItems: [gatekeeperLogoutSettingsItem],
    makeOnUnauthorized: (redirectToDeviceLogin) => redirectToDeviceLogin,
  }
}

export { makeWebEntryOptions }
