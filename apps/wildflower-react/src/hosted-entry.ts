import { serverUrlFromSearch } from 'gatekeeper-core/smart-client'
import {
  makeAwaitHostedAuthReady,
  makeHostedAuthStateStore,
  type HostedAuthStateStore,
} from 'gatekeeper-react'

import type { RenderAppOptions } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'

/**
 * Shared `renderApp` wiring for the hosted web entry (`main-hosted`),
 * where the bearer token lives in page memory and the API origin is
 * chosen via `?server=`.
 *
 * - `tokenStore`: in-memory bearer via `makeHostedAuthStateStore()`.
 *   A page reload returns to `Unauthed` (the bearer is in-memory only).
 * - `awaitAuthReady`: redirects unauthed users to the root landing
 *   page (`/`) instead of device-login, so the server picker + sign-in
 *   flow lives at the root.
 * - `apiBaseUrl`: read from `?server=`, defaulting to the local
 *   loopback origin.
 * - `readBearer`: wired to the hosted store's `bearer()` reader, so
 *   every relative request gets an `Authorization` header.
 * - `makeTransport`: pre-resolved stub (no host bridge).
 * - `platformSettingsItems`: none (no cookie logout on hosted).
 * - `platformTabs`: none.
 * - `redirectToDeviceLoginOnUnauthorized`: true — the hosted entry
 *   has a device-login flow (reached from the landing page).
 */
const makeHostedEntryOptions = (): Pick<
  RenderAppOptions,
  | 'tokenStore'
  | 'awaitAuthReady'
  | 'makeTransport'
  | 'apiBaseUrl'
  | 'readBearer'
  | 'platformSettingsItems'
  | 'platformTabs'
  | 'redirectToDeviceLoginOnUnauthorized'
> & { readonly hostedStore: HostedAuthStateStore } => {
  const hostedStore = makeHostedAuthStateStore()

  const apiBaseUrl = serverUrlFromSearch(window.location.search) ?? 'http://127.0.0.1:8080'

  return {
    hostedStore,
    tokenStore: hostedStore,
    awaitAuthReady: () => makeAwaitHostedAuthReady(hostedStore.subscribable),
    makeTransport: () => Promise.resolve(stubTransport),
    apiBaseUrl,
    readBearer: hostedStore.bearer,
    platformSettingsItems: [],
    platformTabs: [],
    redirectToDeviceLoginOnUnauthorized: true,
  }
}

export { makeHostedEntryOptions }
