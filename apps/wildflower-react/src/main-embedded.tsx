import './instrument.ts'
import { createMemoryHistory } from '@tanstack/react-router'
import { makeAwaitEmbeddedAuthReady, makeEmbeddedAuthTokenStore } from 'gatekeeper-react'
import { makeWebApiOriginBridgeStore } from 'shared-structures-react'
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

// Embedded `WebApiOrigin`: seed with the page's own origin (correct for
// the default build, where the loopback page and loopback API share an
// origin). The host pushes the real loopback origin via
// `HostApiOriginChanged` on every `__Ready` — so when a dev build loads
// the page from a laptop dev server (`EXPO_PUBLIC_DEV_SPA_URL`), the
// SPA's HTTP clients still route their calls back to the in-app loopback
// server. `set` is the navigation handler's `applyApiOrigin`.
const webApiOriginStore = makeWebApiOriginBridgeStore(window.location.origin)

renderApp({
  history: createMemoryHistory(),
  entry: 'main-embedded',
  tokenStore,
  webApiOriginLayer: webApiOriginStore.layer,
  // Embedded auth gate: await the page transport's `signalReady`
  // (so the bridge has had a chance to flush the host's
  // `AuthTokenIssued`), then take the first present value from the
  // store's subscribable. Times out with `TokenTimeout` at the
  // {@link EMBEDDED_TOKEN_TIMEOUT} bound.
  awaitAuthReady: (transportReady) =>
    makeAwaitEmbeddedAuthReady(tokenStore.subscribable, transportReady),
  // `writeIssuedToken` flows into the gatekeeper page-bridge handler so
  // the host's `AuthTokenIssued` push lands here; `webApiOriginStore.set`
  // flows into the navigation handler so `HostApiOriginChanged` re-points
  // the SPA's API origin.
  makeTransport: (navigate, writeIssuedToken) =>
    buildTransport(navigate, writeIssuedToken, webApiOriginStore.set),
})
