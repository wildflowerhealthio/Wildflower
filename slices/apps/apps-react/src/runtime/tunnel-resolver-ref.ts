import type { AppsBridge } from 'apps-core/bridge'
import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'

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
 * boot and the `appsWebHandlers` below closes over this cell, so
 * the transport build does not depend on the React tree. Each
 * `useRequestTunnel` invocation swaps a fresh resolver in for the
 * duration of one request and clears it on settle.
 *
 * Singleton by design — the page has exactly one transport, exactly
 * one in-flight tunnel-request slot. Overlapping requests (e.g. a
 * double-click) supersede the prior one: {@link setPendingTunnelResolver}
 * settles the predecessor with a `superseded by newer request` error
 * before installing the new resolver, so no Promise dangles.
 */
const pendingTunnelResolverRef: { current: PendingResolver | null } = { current: null }

const droppedTagWarning = (tag: string): Effect.Effect<void> =>
  Effect.logWarning(`appsWebHandlers: dropping ${tag} — no pending tunnel request`)

/**
 * `AppsBridge.Web` inbound handler record the app's transport build
 * supplies to `BridgeTransport.make`. Reads {@link pendingTunnelResolverRef}
 * on every Host→Web tag and forwards the outcome to whichever caller is
 * waiting (or log-and-drops if no resolver is installed).
 */
const appsWebHandlers: Bridge.HalfHandlers<(typeof AppsBridge)['Web']> = {
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
}

/**
 * Install or clear the pending tunnel-request resolver.
 *
 * When called with a new resolver while another is already installed
 * (an overlapping request — e.g. a double-click), the predecessor is
 * settled with a `superseded by newer request` error *before* the new
 * resolver takes the slot. This prevents the prior Promise from
 * dangling when its `settled` flag would otherwise lose the race to
 * its own 8s timer, and stops a host response from accidentally
 * resolving the new request with the prior outcome.
 *
 * The predecessor's `settle` closure re-enters via
 * {@link clearPendingTunnelResolverIfCurrent}, which is a no-op once
 * the new resolver has taken the slot; the new `resolver` is then
 * assigned last and wins.
 *
 * See the [Singleton Bridge Refs Explanation](../../../../../docs/Effect/Singleton%20Bridge%20Refs%20Explanation.md)
 * for the broader runtime-singleton invariant this enforces.
 */
const setPendingTunnelResolver = (resolver: PendingResolver | null): void => {
  const previous = pendingTunnelResolverRef.current
  if (resolver !== null && previous !== null) {
    previous({ error: 'superseded by newer request' })
  }
  pendingTunnelResolverRef.current = resolver
}

/**
 * Set-if-equal clear. Only blanks {@link pendingTunnelResolverRef}
 * when it still points at the supplied `resolver`. The supersede
 * pattern above plus each `settle` closure's `settled` flag already
 * cover the in-tree paths; this guard hardens the seam against
 * future callers (or a stale settle invoked twice) by refusing to
 * blank a fresher resolver.
 */
const clearPendingTunnelResolverIfCurrent = (resolver: PendingResolver): void => {
  if (pendingTunnelResolverRef.current === resolver) {
    pendingTunnelResolverRef.current = null
  }
}

export { appsWebHandlers, clearPendingTunnelResolverIfCurrent, setPendingTunnelResolver }
export type { TunnelOutcome }
