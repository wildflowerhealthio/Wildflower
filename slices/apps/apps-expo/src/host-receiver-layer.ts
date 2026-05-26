import AppsBridge from 'apps-core/bridge'
import { Cause, Effect, Layer } from 'effect'
import type { BridgeTransport, MessageHandler } from 'effect-messaging-core'
import type { RefObject } from 'react'
import { TunnelStore } from 'tunnel-core/livestore'
import { awaitTunnelOrigin, commitRequestedRunning } from './commit-and-await-tunnel.ts'

/**
 * Typed host→web sender for {@link AppsBridge}. The host shell exposes
 * one of these per transport via `onTransportReady`; the receiver
 * layer reads it through a {@link RefObject} so the same hook owns
 * both the ref and the layer.
 */
type AppsHostMessageSender = BridgeTransport.MessageSender<readonly [typeof AppsBridge], 'Host'>

/** Inbound web→host messages defined on {@link AppsBridge}. */
type AppsHostToWebMessage = Parameters<AppsHostMessageSender>[0]

/**
 * Send {@link AppsHostToWebMessage} via the captured `senderRef`.
 * Pre-mount calls (transport not yet built) are loud-dropped via
 * `Effect.logError`, matching the convention in browser-sniffer-expo.
 */
const sendOrDrop = (
  senderRef: RefObject<AppsHostMessageSender | null>,
  message: AppsHostToWebMessage
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const send = senderRef.current
    if (send === null) {
      return Effect.logError('[apps-expo] dropped pre-mount message', { tag: message._tag })
    }
    return send(message)
  })

/**
 * Host receiver layer for `AppsBridge`. `RequestTunnel` flips
 * `TunnelConfig.requestedRunning`, awaits the tunnel daemon to bind,
 * and replies with `TunnelStarted { origin }` or `TunnelFailed`.
 *
 * @param senderRef - Host→web sender captured via `onTransportReady`.
 *   Owned by {@link useAppsHostBinding}; pre-mount sends drop loud.
 *
 * @remarks
 * Requires {@link TunnelStore}; discharge with
 * `Layer.provide(TunnelStore.layerFrom(store))` at the call site
 * (typically the host-binding hook).
 */
const ReceiverLayer = (
  senderRef: RefObject<AppsHostMessageSender | null>
): Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>, never, TunnelStore> =>
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const tunnelStore = yield* TunnelStore
      return AppsBridge.Host.ReceiverLayer({
        RequestTunnel: () =>
          Effect.gen(function* () {
            yield* commitRequestedRunning(tunnelStore, true)
            return yield* awaitTunnelOrigin(tunnelStore)
          }).pipe(
            Effect.matchCauseEffect({
              onSuccess: (origin) => sendOrDrop(senderRef, { _tag: 'TunnelStarted', origin }),
              onFailure: (cause) =>
                sendOrDrop(senderRef, { _tag: 'TunnelFailed', reason: Cause.pretty(cause) }),
            })
          ),
      })
    })
  )

export { ReceiverLayer }
export type { AppsHostMessageSender, AppsHostToWebMessage }
