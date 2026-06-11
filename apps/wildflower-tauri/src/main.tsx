import { createBrowserHistory } from '@tanstack/react-router'
import { listen } from '@tauri-apps/api/event'
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

// Fatal host-side failures (e.g. the API server failed to bind/stopped)
// arrive on `bridge:FatalError` — pinned by `src-tauri/src/bridge.rs`
// (`FATAL_ERROR_EVENT`). Without the server the app can't reach the API
// at all, so surface the message rather than leave the user staring at a
// wedged shell. Registered before any async boot so a fast bind failure
// can't beat the listener. Rendering a banner would need a UI surface
// the shell doesn't expose yet; for now an `alert` makes the failure
// unmissable instead of invisible.
void listen<string>('bridge:FatalError', (event) => {
  globalThis.alert(event.payload)
})

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
  // paths must be pinned to the host's loopback origin. `__API_ORIGIN__`
  // is injected by Vite (`vite.config.ts`) from the shared
  // `api-origin.json`, the same file the Rust server reads in
  // `src-tauri/build.rs` to bind its host/port — so this origin can't
  // drift from the server. 127.0.0.1 matches the canonical `Host:` form
  // the gatekeeper's token verifier expects.
  apiBaseUrl: __API_ORIGIN__,
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
      //
      // Capture the un-patched `console.error` BEFORE installing the
      // interceptor: `Effect.runFork` reports unhandled fiber failures
      // through the runtime's default logger, which writes to the
      // now-patched `console`. If `transport.sendMessage` fails, routing
      // that failure back through the patched console would re-enter the
      // interceptor and fork another failing send — an unbounded
      // feedback loop with every diagnostic invisible. `catchAllCause`
      // drains send failures to the captured original sink so they can
      // never re-enter the interceptor.
      // oxlint-disable-next-line no-console
      const reportSendFailure = console.error.bind(console)
      Logging.installConsoleInterceptor((message) => {
        Effect.runFork(
          transport.sendMessage(message).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                reportSendFailure('[bridge:Log] failed to forward console message', cause)
              })
            )
          )
        )
      })
      return transport
    }),
})
