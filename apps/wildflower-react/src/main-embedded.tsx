import './instrument.ts'
import { createMemoryHistory } from '@tanstack/react-router'
import { makeAwaitEmbeddedAuthReady, makeEmbeddedAuthTokenStore } from 'gatekeeper-react'
import 'tundra-css'
import 'react-tundraish/styles.css'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { buildTransport } from './bridges/build-transport.ts'

// Embedded `AuthTokenStore`: in-memory only, initial value `null`.
// The host re-mints and pushes the bearer over the gatekeeper bridge
// on every WebView session, so a `localStorage`-cached value can only
// ever be stale and would race the host's fresh push (TanStack Query
// loaders fire with the cached value, hit 401 against the
// freshly-rotated LHS daemon, and pin the failure in cache). See
// `makeEmbeddedAuthTokenStore`'s docstring.
const tokenStore = makeEmbeddedAuthTokenStore()

renderApp({
  history: createMemoryHistory(),
  entry: 'main-embedded',
  tokenStore,
  // Embedded auth gate: await the page transport's `signalReady`
  // (so the bridge has had a chance to flush the host's
  // `AuthTokenIssued`), then take the first present value from the
  // store's subscribable. Times out with `TokenTimeout` at the
  // {@link EMBEDDED_TOKEN_TIMEOUT} bound.
  awaitAuthReady: (transportReady) =>
    makeAwaitEmbeddedAuthReady(tokenStore.subscribable, transportReady),
  // `writeIssuedToken` and `setActiveDeviceRequest` flow into the
  // gatekeeper page-bridge handler so the host's `AuthTokenIssued` and
  // `DeviceAuthorizationActiveChanged` pushes land here.
  makeTransport: (navigate, writeIssuedToken, setActiveDeviceRequest) =>
    buildTransport(navigate, writeIssuedToken, setActiveDeviceRequest),
})
