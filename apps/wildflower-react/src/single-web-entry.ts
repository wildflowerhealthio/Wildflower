import {
  gatekeeperLogoutSettingsItem,
  makeAwaitDeviceLoginAuthReady,
  makeCookieAuthStateStore,
} from 'gatekeeper-react'
import type { RenderAppOptions } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'

/**
 * `renderApp` wiring for `main-single-web` — the single-file bundle the host
 * embeds and serves itself (`apps/wildflower-tauri/src-tauri/src/spa.rs`
 * `include_str!`s it), so the page is always **same-origin** with the API.
 *
 * That origin is the whole difference from `main-web` (see `web-entry.ts`).
 * Same-origin means the `HttpOnly` `wf_auth` cookie rides every request on its
 * own, so this entry holds no credential and sets no `Authorization` header;
 * `main-web` runs cross-origin against a `?server=` the reader picks, where the
 * cookie is never sent and a bearer in page memory is the only option.
 *
 * It's a factory, not a wrapper over `renderApp`, so the entry keeps its
 * explicit `renderApp` call site (and embedded stays untouched).
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
 *   `PendingConsentRequested` from on standalone web.
 * - `platformSettingsItems`: the web logout row — a same-origin
 *   `POST /access/logout` form. Web-only: on Tauri the session is
 *   connection-provenance, so a cookie logout is a no-op.
 * - `platformTabs`: none. The HAR Recorder, the only platform tab, needs a
 *   sniffer webview and a host filesystem, so the Tauri shell contributes it.
 * - `redirectToDeviceLoginOnUnauthorized`: this entry HAS a device-login
 *   flow, so a 401 that outlives the boot-race retry redirects the user there.
 */
const makeSingleWebEntryOptions = (): Pick<
  RenderAppOptions,
  | 'tokenStore'
  | 'awaitAuthReady'
  | 'makeTransport'
  | 'platformSettingsItems'
  | 'platformTabs'
  | 'redirectToDeviceLoginOnUnauthorized'
> => {
  const tokenStore = makeCookieAuthStateStore()
  return {
    tokenStore,
    awaitAuthReady: () => makeAwaitDeviceLoginAuthReady(tokenStore.subscribable),
    makeTransport: () => Promise.resolve(stubTransport),
    platformSettingsItems: [gatekeeperLogoutSettingsItem],
    platformTabs: [],
    redirectToDeviceLoginOnUnauthorized: true,
  }
}

export { makeSingleWebEntryOptions }
