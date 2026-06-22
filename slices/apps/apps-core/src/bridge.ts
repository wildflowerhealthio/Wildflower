import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * Web → Host: the apps SPA asks the host to start a tunnel so an app
 * that requires a publicly-reachable origin can be launched. The host
 * either opens a tunnel and replies with {@link TunnelStarted} carrying
 * the new origin, or replies with {@link TunnelFailed} on error.
 */
const RequestTunnel = Schema.parseJson(Schema.TaggedStruct('RequestTunnel', {}))

/**
 * Web → Host: the apps SPA asks the host to open a launched app in a separate,
 * less-privileged native webview popup (presented by the Tauri host via
 * `tauri-plugin-native-webview`, with native chrome) instead of navigating the
 * main webview away from the SPA. `url` is the fully-resolved launch URL (origin
 * + `/apps/{id}`); the host opens it, following the launch redirect itself.
 * Fire-and-forget — there is no host→web reply, and a non-Tauri (standalone-web)
 * page never emits this (it navigates directly instead).
 */
const RequestSandboxedWebView = Schema.parseJson(
  Schema.TaggedStruct('RequestSandboxedWebView', { url: Schema.String })
)

/**
 * Host → Web: the host successfully started a tunnel; `origin` is the
 * publicly-reachable origin the SPA should redirect to in order to
 * launch a tunnel-requiring app.
 */
const TunnelStarted = Schema.parseJson(
  Schema.TaggedStruct('TunnelStarted', { origin: Schema.String })
)

/**
 * Host → Web: the host failed to start a tunnel; `reason` is a short
 * human-readable description suitable for surfacing as an inline error.
 */
const TunnelFailed = Schema.parseJson(
  Schema.TaggedStruct('TunnelFailed', { reason: Schema.String })
)

type AppsBridge = Bridge.Bridge<
  'Apps',
  {
    TunnelStarted: typeof TunnelStarted
    TunnelFailed: typeof TunnelFailed
  },
  {
    RequestTunnel: typeof RequestTunnel
    RequestSandboxedWebView: typeof RequestSandboxedWebView
  }
>

/**
 * Slice-level bridge between the embedded apps SPA and the Tauri/Expo host.
 * Web→Host carries the tunnel-request control signal and the
 * open-in-sandboxed-webview launch request; Host→Web carries the tunnel
 * start/fail outcome the SPA waits on before redirecting to a tunnel-requiring
 * app. The transport-level `__Ready` handshake already covers mount
 * synchronisation — no slice-level `Ready` tag.
 */
const AppsBridge: AppsBridge = Bridge.make({
  name: 'Apps',
  hostToWeb: [
    ['TunnelStarted', TunnelStarted],
    ['TunnelFailed', TunnelFailed],
  ] as const,
  webToHost: [
    ['RequestTunnel', RequestTunnel],
    ['RequestSandboxedWebView', RequestSandboxedWebView],
  ] as const,
})

export { AppsBridge, RequestSandboxedWebView, RequestTunnel, TunnelFailed, TunnelStarted }
