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
  }
>

/**
 * Slice-level bridge between the embedded apps SPA and the Expo host.
 * Web→Host carries the tunnel-request control signal; Host→Web carries
 * the tunnel start/fail outcome the SPA waits on before redirecting to
 * a tunnel-requiring app. The transport-level `__Ready` handshake
 * already covers mount synchronisation — no slice-level `Ready` tag.
 */
const AppsBridge: AppsBridge = Bridge.make({
  name: 'Apps',
  hostToWeb: [
    ['TunnelStarted', TunnelStarted],
    ['TunnelFailed', TunnelFailed],
  ] as const,
  webToHost: [['RequestTunnel', RequestTunnel]] as const,
})

export default AppsBridge
export { RequestTunnel, TunnelFailed, TunnelStarted }
