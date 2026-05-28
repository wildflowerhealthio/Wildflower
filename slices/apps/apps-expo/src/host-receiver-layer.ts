import { AppsBridge } from 'apps-core/bridge'
import { Cause, Effect, Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { TunnelStore } from 'tunnel-core/livestore'
import { awaitTunnelOrigin, commitRequestedRunning } from './commit-and-await-tunnel.ts'

/**
 * Host receiver layer for `AppsBridge`. `RequestTunnel` flips
 * `TunnelConfig.requestedRunning`, awaits the tunnel daemon to bind,
 * and replies with `TunnelStarted { origin }` or `TunnelFailed`.
 *
 * @remarks
 * Requires {@link TunnelStore}; discharge with
 * `Layer.provide(TunnelStore.layerFrom(store))` at the call site
 * (typically `useAppsHostBinding`).
 *
 * Handler replies route through `AppsBridge.Host.send(...)` directly —
 * the bridge transport's dispatch fiber provides the per-invocation
 * `TransportAdapter` the sender needs.
 */
const ReceiverLayer: Layer.Layer<
  MessageHandler.TagId<'Apps', 'Host'>,
  never,
  TunnelStore
> = Layer.unwrapEffect(
  Effect.map(TunnelStore, (tunnelStore) =>
    AppsBridge.Host.ReceiverLayer({
      RequestTunnel: () =>
        commitRequestedRunning(tunnelStore, true).pipe(
          Effect.andThen(awaitTunnelOrigin(tunnelStore)),
          Effect.matchCauseEffect({
            onSuccess: (origin) => AppsBridge.Host.send({ _tag: 'TunnelStarted', origin }),
            onFailure: (cause) =>
              AppsBridge.Host.send({ _tag: 'TunnelFailed', reason: Cause.pretty(cause) }),
          })
        ),
    })
  )
)

export { ReceiverLayer }
