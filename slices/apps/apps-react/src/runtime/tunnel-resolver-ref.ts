import { AppsBridge } from 'apps-core/bridge'
import { Effect, type Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'

/**
 * The tunnel-response outcomes the apps runtime resolves a pending
 * `useRequestTunnel` call with. Mirrors the AppsBridge Host→Web
 * messages — `_tag: 'TunnelStarted'` carries the new origin,
 * `_tag: 'TunnelFailed'` carries a human-readable reason — flattened
 * into the shape callers actually observe (`{ origin } | { error }`).
 */
type TunnelOutcome = { readonly origin: string } | { readonly error: string }

type PendingResolver = (outcome: TunnelOutcome) => void

/**
 * Module-level cell holding the in-flight tunnel-request resolver (or
 * `null` when no request is pending). Mirrors the gatekeeper slice's
 * `authTokenRef` pattern: the page builds its `BridgeTransport` once at
 * boot and the `appsWebReceiverLayer` below closes over this cell, so
 * the transport build does not depend on the React tree. Each
 * `useRequestTunnel` invocation swaps a fresh resolver in for the
 * duration of one request and clears it on settle.
 *
 * Singleton by design — the page has exactly one transport, exactly
 * one in-flight tunnel-request slot. Last writer wins; an overlapping
 * second request would clobber the first (today's behaviour, preserved
 * by the lift).
 */
const pendingTunnelResolverRef: { current: PendingResolver | null } = { current: null }

const droppedTagWarning = (tag: string): Effect.Effect<void> =>
  Effect.logWarning(`appsWebReceiverLayer: dropping ${tag} — no pending tunnel request`)

/**
 * `AppsBridge.Web` `ReceiverLayer` the app's transport build supplies
 * to `BridgeTransport.make`. Reads {@link pendingTunnelResolverRef} on
 * every Host→Web tag and forwards the outcome to whichever caller is
 * waiting (or log-and-drops if no resolver is installed).
 */
const appsWebReceiverLayer: Layer.Layer<MessageHandler.TagId<typeof AppsBridge.name, 'Web'>> =
  AppsBridge.Web.ReceiverLayer({
    TunnelStarted: ({ origin }) => {
      const resolver = pendingTunnelResolverRef.current
      if (resolver === null) return droppedTagWarning('TunnelStarted')
      pendingTunnelResolverRef.current = null
      return Effect.sync(() => {
        resolver({ origin })
      })
    },
    TunnelFailed: ({ reason }) => {
      const resolver = pendingTunnelResolverRef.current
      if (resolver === null) return droppedTagWarning('TunnelFailed')
      pendingTunnelResolverRef.current = null
      return Effect.sync(() => {
        resolver({ error: reason })
      })
    },
  })

const setPendingTunnelResolver = (resolver: PendingResolver | null): void => {
  pendingTunnelResolverRef.current = resolver
}

export { appsWebReceiverLayer, setPendingTunnelResolver }
export type { TunnelOutcome }
