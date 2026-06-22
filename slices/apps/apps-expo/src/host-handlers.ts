import type { AppsBridge } from 'apps-core/bridge'
import { Cause, Effect } from 'effect'
import type { BridgeTransport, MessageHandler } from 'effect-messaging-core'
import { awaitTunnelOrigin, commitRequestedRunning } from './commit-and-await-tunnel.ts'

/** The apps bridge's host→web sender — `RequestTunnel` replies ride this. */
type AppsHostSender = BridgeTransport.MessageSender<readonly [typeof AppsBridge], 'HostToWeb'>

/**
 * Build the host-side inbound handler record for `AppsBridge`.
 * `RequestTunnel` asks the tunnel to start, awaits a public origin, and
 * replies with `TunnelStarted { origin }` or `TunnelFailed { reason }`
 * through the supplied `reply` sender.
 *
 * @remarks
 * NO-OP today: {@link commitRequestedRunning} / {@link awaitTunnelOrigin} are
 * reference seams (the livestore tunnel daemon was removed with the TS server
 * stack), so `RequestTunnel` currently always replies `TunnelFailed`. Rewire
 * the seams to the Rust tunnel to bring this back. Handlers stay pure
 * `Effect<void>`; the proactive reply rides the passed-in sender rather than a
 * module-level global.
 *
 * `RequestSandboxedWebView` is a **Tauri-only** flow: the apps SPA only emits it
 * when `window.__TAURI__` is present (the Tauri host opens the launch URL in a
 * native webview popup via `tauri-plugin-native-webview`); on the Expo WebView
 * host the SPA navigates the page directly instead, so this handler never fires
 * in practice. The exhaustive `HandlersFor` contract still requires an entry, so
 * it logs and ignores rather than crash if one ever arrives.
 */
const makeAppsHostHandlers = (
  reply: AppsHostSender
): MessageHandler.HandlersFor<(typeof AppsBridge)['WebToHost']> => ({
  RequestTunnel: () =>
    commitRequestedRunning(true).pipe(
      Effect.andThen(awaitTunnelOrigin()),
      Effect.matchCauseEffect({
        onSuccess: (origin) => reply({ _tag: 'TunnelStarted', origin }),
        onFailure: (cause) => reply({ _tag: 'TunnelFailed', reason: Cause.pretty(cause) }),
      })
    ),
  RequestSandboxedWebView: ({ url }) =>
    Effect.logWarning(
      `AppsBridge: ignoring RequestSandboxedWebView (${url}) in the Expo host — the native webview popup is a Tauri-only flow.`
    ),
})

export { makeAppsHostHandlers }
export type { AppsHostSender }
