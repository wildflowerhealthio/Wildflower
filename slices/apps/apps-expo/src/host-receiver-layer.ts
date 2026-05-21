import AppsBridge from 'apps-core/bridge'
import { Effect, Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { TunnelStore } from 'tunnel-core/livestore'
import { commitAndAwaitTunnel } from './commit-and-await-tunnel.ts'

/**
 * Host receiver layer for `AppsBridge`. `RequestTunnel` flips
 * `TunnelConfig.requestedRunning`, awaits the tunnel daemon to bind,
 * and replies with `TunnelStarted { origin }` or `TunnelFailed`.
 * Requires {@link TunnelStore}; discharge with
 * `Layer.provide(TunnelStore.layerFrom(store))` at the call site.
 */
const ReceiverLayer = (): Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>, never, TunnelStore> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const tunnelStore = yield* TunnelStore
      return AppsBridge.Host.ReceiverLayer({
        RequestTunnel: () =>
          commitAndAwaitTunnel(tunnelStore, true).pipe(
            Effect.matchEffect({
              onSuccess: (origin) =>
                origin === null
                  ? Effect.void
                  : AppsBridge.Host.send({ _tag: 'TunnelStarted', origin }),
              onFailure: (cause) =>
                AppsBridge.Host.send({ _tag: 'TunnelFailed', reason: String(cause) }),
            })
          ),
      })
    })
  )

export { ReceiverLayer }
