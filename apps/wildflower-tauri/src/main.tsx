import { createBrowserHistory } from '@tanstack/react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'scopes-react/styles.css'
import 'wildflower-react/instrument'
import 'wildflower-react/global.css'
import { Effect } from 'effect'
import { Logging } from 'effect-messaging-core'
import { makeTauriTransport } from 'effect-messaging-tauri'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { makeAwaitEmbeddedAuthReady, makeEmbeddedAuthStateStore } from 'gatekeeper-react'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import { renderApp } from 'wildflower-react/app-root'
import { bridges } from 'wildflower-react/bridges'
import { addOsColorSchemeListener } from 'wildflower-react/os-color-scheme-listener'

addOsColorSchemeListener()

// In-memory store, initial value `null`. On the Tauri path the SPA never
// holds the bearer: the host plants the `wf_auth` cookie directly in the
// webview's cookie jar (it rides loopback fetches), and the contentless
// `AuthTokenIssued` notify the host emits on each `bridge:__Ready` and on
// re-mint just flips this store's auth-readiness signal.
const tokenStore = makeEmbeddedAuthStateStore()

renderApp({
  history: createBrowserHistory(),
  entry: 'main-tauri',
  tokenStore,
  // The page is served from the Vite dev server (dev) or Tauri's asset
  // protocol (build) — NOT from the Rust API server — so relative API
  // paths must be pinned to the host's loopback origin.
  // `WILDFLOWER_LOOPBACK_ORIGIN` is injected by Vite (`vite.config.ts`) from
  // the shared `tauri-shared-config.json`, the same file the Rust server reads
  // in `src-tauri/build.rs` to bind its hostname/port — so this origin can't
  // drift from the server. 127.0.0.1 matches the canonical `Host:` form
  // loopback requests carry to the gatekeeper.
  apiBaseUrl: WILDFLOWER_LOOPBACK_ORIGIN,
  // No platform settings rows: the web logout row is meaningless here (the
  // session is the host's loopback-owner trust, re-authenticated per request —
  // clearing a cookie logs nothing out, and this origin doesn't serve
  // `/access/logout`). The entry, not the settings route, encodes that.
  platformSettingsItems: [],
  // A 401 here is anomalous (a boot-race before the host token is minted, or an
  // expired host token), NOT a prompt to sign in: the webview is
  // host-authenticated by the loopback-owner trust, there's no user login to
  // fall back to, and driving the device flow would spawn a spurious
  // "authorize this device" consent against the owner's own device. So Tauri
  // takes no 401 action — the query surfaces its error and the boot-race retry
  // covers the common case.
  redirectToDeviceLoginOnUnauthorized: false,
  // The host's granted scopes, injected by Vite (`vite.config.ts`) from the same
  // `tauri-shared-config.json` gatekeeper-rust reads to seed the first-party
  // client — so `NeedsAuthMessage`'s device-login request can't drift from the
  // seeded `allowed_scopes`.
  localGrantedScopes: WILDFLOWER_LOCAL_GRANTED_SCOPES,
  // Same gate as embedded: wait for the transport's readiness signal
  // (so the host has had its chance to push `AuthTokenIssued`), then
  // take the first present token from the store.
  awaitAuthReady: (transportReady) =>
    makeAwaitEmbeddedAuthReady(tokenStore.subscribable, transportReady),
  // Tauri-native transport over per-tag events; only the gatekeeper
  // bridge needs a boot-stable handler (the host pushes the token and
  // any pending device-consent head before any slice mounts). Other
  // slices register on mount through the coordinator, exactly as on
  // embedded.
  makeTransport: (_navigate, writeIssuedToken, setActiveDeviceUserCode) =>
    makeTauriTransport({
      bridges,
      initial: {
        [GatekeeperBridge.name]: makeGatekeeperWebHandlers(
          writeIssuedToken,
          setActiveDeviceUserCode
        ),
      },
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
