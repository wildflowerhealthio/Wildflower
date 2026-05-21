import AppsBridge from 'apps-core/bridge'
import { Effect, Layer } from 'effect'
import { BareSender, type MessageHandler } from 'effect-messaging-core'
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
 * The returned layer requires {@link TunnelStore} and {@link BareSender}:
 *
 *  - `TunnelStore` is the slice-store Tag exposed by `tunnel-core` —
 *    discharge it with `Layer.provide(TunnelStore.layerFrom(store))`
 *    at the call site, passing the app-level livestore that includes
 *    tunnel-core's tables.
 *  - `BareSender` is supplied automatically by the bridge transport
 *    during dispatch (`bridge-transport.ts` provides it alongside the
 *    receiver layers) — call sites don't wire it explicitly.
 *
 * The handler resolves `BareSender` once at layer-build time and
 * re-provides it inside the `RequestTunnel` effect so the handler
 * still types as `Effect<void, never, never>` (the shape
 * `HandlersFor` requires), without forcing the call site to plumb a
 * sendback callback like the previous `getHandle` design did.
 */
const ReceiverLayer = (): Layer.Layer<
  MessageHandler.TagId<'Apps', 'Host'>,
  never,
  TunnelStore | BareSender
> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const tunnelStore = yield* TunnelStore
      const bareSender = yield* BareSender

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
            }),
            Effect.provide(Layer.succeed(BareSender, bareSender))
          ),
      })
    })
  )

export { ReceiverLayer }
