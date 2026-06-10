import { createBrowserHistory } from '@tanstack/react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'wildflower-react/instrument'
import 'wildflower-react/global.css'
import { Effect } from 'effect'
import { Logging } from 'effect-messaging-core'
import { makeTauriTransport } from 'effect-messaging-tauri'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { makeAwaitEmbeddedAuthReady, makeEmbeddedAuthTokenStore } from 'gatekeeper-react'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import { renderApp } from 'wildflower-react/app-root'
import { bridges } from 'wildflower-react/bridges'
import { addOsColorSchemeListener } from 'wildflower-react/os-color-scheme-listener'

addOsColorSchemeListener()

// Embedded-style store: in-memory, initial value `null`. The Rust host
// re-delivers the bearer over the bridge on every page load (it replies
// to each `bridge:__Ready` with `AuthTokenIssued`), so persisting a
// token could only ever serve a stale value.
const tokenStore = makeEmbeddedAuthTokenStore()

renderApp({
  history: createBrowserHistory(),
  entry: 'main-tauri',
  tokenStore,
  // The page is served from the Vite dev server (dev) or Tauri's asset
  // protocol (build) — NOT from the Rust API server — so relative API
  // paths must be pinned to the host's loopback origin. The port is
  // pinned in `src-tauri/src/lib.rs` (`ServerRuntimeConfig`), and
  // 127.0.0.1 matches the canonical `Host:` form the gatekeeper's
  // token verifier expects.
  apiBaseUrl: 'http://127.0.0.1:8080',
  // Same gate as embedded: wait for the transport's readiness signal
  // (so the host has had its chance to push `AuthTokenIssued`), then
  // take the first present token from the store.
  awaitAuthReady: (transportReady) =>
    makeAwaitEmbeddedAuthReady(tokenStore.subscribable, transportReady),
  // Tauri-native transport over per-tag events; only the gatekeeper
  // bridge needs a boot-stable handler (the host pushes the token
  // before any slice mounts). Other slices register on mount through
  // the coordinator, exactly as on embedded.
  makeTransport: (_navigate, writeIssuedToken) =>
    makeTauriTransport({
      bridges,
      initial: { [GatekeeperBridge.name]: makeGatekeeperWebHandlers(writeIssuedToken) },
    }).then((transport) => {
      // Webview console → `bridge:Log` events → the Rust log facade.
      // One-way: the host's log plugin has no Webview target, so this
      // cannot loop. Installed only after the transport resolves —
      // earlier console output stays local, which is fine for boot.
      Logging.installConsoleInterceptor((message) => {
        Effect.runFork(transport.sendMessage(message))
      })
      return transport
    }),
})
