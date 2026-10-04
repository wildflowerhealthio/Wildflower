// oxlint-disable import/max-dependencies -- the Tauri entry wires every host-backed slice (transport, auth, server status, recovery) into the app root
import { createBrowserHistory } from '@tanstack/react-router'
import { BackgroundServerServiceBridge } from 'background-server-service-core'
import {
  backgroundServerServiceSettingsItemsFragment,
  makeBackgroundServerServiceWebHandlers,
  ServerStatusBanner,
} from 'background-server-service-react'
import { sectionUrl, WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from 'branding-core'
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'wildflower-react/global.css'
import { Effect } from 'effect'
import { Logging } from 'effect-messaging-core'
import { makeTauriTransport } from 'effect-messaging-tauri'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { makeAwaitEmbeddedAuthReady, makeEmbeddedAuthStateStore } from 'gatekeeper-react'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import type { JSX } from 'react'
import { addOsColorSchemeListener } from 'react-tundraish'
import { configureRecovery } from 'tauri-plugin-background-service'
import { consentedTelemetryLayer } from 'telemetry-web'
import { buildAppTree, mountAtRoot } from 'wildflower-react/app-root'
import { bridges } from 'wildflower-react/bridges'
import { ConsentedEntryRoot } from 'wildflower-react/consented-entry-root'
import { ServerKind } from 'wildflower-react/server-kind'
// Named imports, so only these two fields of the host's configuration reach
// the bundle.
import {
  background_service_foreground_type as backgroundServiceForegroundType,
  background_service_label as backgroundServiceLabel,
} from '../tauri-shared-config.json'

addOsColorSchemeListener()

// The host starts the server itself, from Rust, at launch. This records that
// the server should keep running, so the background-service plugin restarts it
// after the OS ends the app: in an iOS background window, or through Android's
// tap-to-resume notification. The start config is the one the host starts with,
// read from the same `tauri-shared-config.json` the host's `build.rs` reads. The
// server runs either way, so a failure only costs those restarts, and is logged.
Effect.runFork(
  Effect.tryPromise(() =>
    configureRecovery({
      enabled: true,
      config: {
        serviceLabel: backgroundServiceLabel,
        foregroundServiceType: backgroundServiceForegroundType,
      },
    })
  ).pipe(
    Effect.catchAll((error) =>
      Effect.logError(
        '[background-service] the server will not restart after the OS ends the app',
        error
      )
    )
  )
)

// In-memory store, initial value `Unauthed`. On the Tauri path the SPA never
// holds the bearer: the host authenticates the webview's direct-loopback
// fetches by connection provenance, stamping its own owner bearer onto each
// one, and the contentless `AuthTokenIssued` notify the host emits on each
// `bridge:__Ready` and on re-mint just flips this store's auth-readiness
// signal.
const tokenStore = makeEmbeddedAuthStateStore()

/**
 * Build the app: its query runtime, the Tauri transport and the router.
 * `ConsentedEntryRoot` calls this once the user has answered the telemetry
 * consent dialog, so no transport or runtime exists before an answer.
 */
const bootApp = (): Promise<JSX.Element> =>
  Promise.resolve(
    buildAppTree({
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
      // Empty until the user's answer turns performance on: this entry never
      // starts telemetry from the build's env.
      effectTelemetryLayer: consentedTelemetryLayer,
      // The server this host runs. No logout row: it is meaningless here (the
      // session is the host's loopback-owner trust, re-authenticated per request,
      // so the page holds nothing to forget or revoke). The entry, not the
      // settings route, encodes both.
      platformSettingsItems: backgroundServerServiceSettingsItemsFragment,
      // Desktop-only: the recorder drives the native sniffer webview and the host
      // writes the `.har` into `saved_data`, neither of which a browser tab has.
      platformTabs: [{ key: 'har-recorder', label: 'HAR Recorder', path: '/har-recorder' }],
      // This host runs the Wildflower server, so the shell says when it isn't
      // running and offers to restart it.
      platformBanner: <ServerStatusBanner />,
      // A 401 here is anomalous (a boot-race before the host token is minted, or an
      // expired host token), NOT a prompt to sign in: the webview is
      // host-authenticated by the loopback-owner trust, there's no user login to
      // fall back to, and driving the device flow would spawn a spurious
      // "authorize this device" consent against the owner's own device. So Tauri
      // takes no 401 action — the query surfaces its error and the boot-race retry
      // covers the common case.
      redirectToDeviceLoginOnUnauthorized: false,
      // The host is a Wildflower server, so the shell offers every surface.
      serverKind: ServerKind.Wildflower(),
      // The host's granted scopes, injected by Vite (`vite.config.ts`) from the same
      // `tauri-shared-config.json` gatekeeper-rust reads to seed the first-party
      // client — so `NeedsAuthMessage`'s device-login request can't drift from the
      // seeded `allowed_scopes`.
      localGrantedScopes: WILDFLOWER_LOCAL_GRANTED_SCOPES,
      // The host's first-party OAuth `client_id`, injected by Vite (`vite.config.ts`)
      // from the same `tauri-shared-config.json` gatekeeper-rust reads to seed the
      // first-party client — so `NeedsAuthMessage`'s device-login `client_id` can't
      // drift from the seeded id.
      firstPartyClientId: WILDFLOWER_FIRST_PARTY_CLIENT_ID,
      // The webview's own origin (the dev server or Tauri's asset protocol) is not
      // an address another device can open, so a device-flow pairing link points
      // at the hosted owner UI instead.
      externalLinkRoot: () => sectionUrl('app'),
      // Same gate as embedded: wait for the transport's readiness signal
      // (so the host has had its chance to push `AuthTokenIssued`), then
      // take the first present token from the store.
      awaitAuthReady: (transportReady) =>
        makeAwaitEmbeddedAuthReady(tokenStore.subscribable, transportReady),
      // Tauri-native transport over per-tag events. The gatekeeper and
      // background-server-service bridges need boot-stable handlers: the host
      // answers `__Ready` with the token, any pending-consent head and the server
      // status before any slice mounts. Other slices register on mount through
      // the coordinator, exactly as on embedded.
      makeTransport: (writeIssuedToken, setActivePendingConsent, setServerServiceStatus) =>
        makeTauriTransport({
          bridges,
          initial: {
            [GatekeeperBridge.name]: makeGatekeeperWebHandlers(
              writeIssuedToken,
              setActivePendingConsent
            ),
            [BackgroundServerServiceBridge.name]:
              makeBackgroundServerServiceWebHandlers(setServerServiceStatus),
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
  )

// The consent dialog first; the answer starts telemetry and then boots the app.
mountAtRoot(
  <ConsentedEntryRoot
    entry="main-tauri"
    copy={WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY}
    bootApp={bootApp}
  />
)
