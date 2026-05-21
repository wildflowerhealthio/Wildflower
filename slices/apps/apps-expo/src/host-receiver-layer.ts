import AppsBridge from 'apps-core/bridge'
import { Effect, Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { TunnelStore } from 'tunnel-core/livestore'
import { commitAndAwaitTunnel } from './commit-and-await-tunnel.ts'

/**
 * Build the host-side `ReceiverLayer` for `AppsBridge`. Handles
 * `RequestTunnel` by:
 *
 *  1. Committing `TunnelConfig.requestedRunning: true`.
 *  2. Awaiting the tunnel daemon to bind (`TunnelState.running` with
 *     a non-null `currentSubdomain` + `currentRootDomain`).
 *  3. Replying with `TunnelStarted { origin }` on success, or
 *     `TunnelFailed { reason }` on timeout.
 *
 * The returned layer requires {@link TunnelStore}; discharge it with
 * `Layer.provide(TunnelStore.layerFrom(store))` at the call site,
 * passing the app-level livestore that includes tunnel-core's tables.
 *
 * `BareSender` is *not* a layer-build requirement — the bridge
 * transport's dispatch fiber provides it inside each handler
 * invocation, so `AppsBridge.Host.send(...)` inside the `RequestTunnel`
 * handler resolves naturally without the host having to plumb a
 * ref-resolved sender into the layer.
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
