import type { AppsBridge } from 'apps-core/bridge'
import { Cause, Effect } from 'effect'
import { type BridgeTransport, HandlerHelpers, type MessageHandler } from 'effect-messaging-core'
import {
  awaitTunnelOrigin,
  commitRequestedRunning,
  type TunnelStoreService,
} from './commit-and-await-tunnel.ts'

/** The apps bridge's host→web sender — `RequestTunnel` replies ride this. */
type AppsHostSender = BridgeTransport.MessageSender<readonly [typeof AppsBridge], 'HostToWeb'>

/** A host→web message the apps bridge can send (`TunnelStarted` | `TunnelFailed`). */
type AppsHostMessage = Parameters<AppsHostSender>[0]

/**
 * Module-level cell holding the apps bridge's host→web sender (or `null`
 * before the transport is ready). Mirrors the apps-react slice's
 * `pendingTunnelResolverRef`: the handler record {@link makeAppsHostHandlers}
 * returns closes over this cell, so the transport build does not depend
 * on the React tree, and `useAppsHostBinding` captures the live sender
 * into it via the binding's `onTransportReady`.
 *
 * Singleton by design — the host has exactly one apps transport, so one
 * sender slot.
 */
const appsHostSenderRef: { current: AppsHostSender | null } = { current: null }

/** Install (or clear) the apps host→web sender captured at transport-ready. */
const setAppsHostSender = (send: AppsHostSender | null): void => {
  appsHostSenderRef.current = send
}

/**
 * Reply to a `RequestTunnel` over the captured host→web sender, or
 * log-and-drop if the transport isn't ready yet (sender still `null`).
 */
const reply = (message: AppsHostMessage): Effect.Effect<void> => {
  const send = appsHostSenderRef.current
  return send === null
    ? HandlerHelpers.droppedTagWarning('appsHostHandlers', message._tag)
    : send(message)
}

/**
 * Build the host-side inbound handler record for `AppsBridge`.
 * `RequestTunnel` flips `TunnelConfig.requestedRunning`, awaits the
 * tunnel daemon to bind, and replies with `TunnelStarted { origin }`
 * or `TunnelFailed { reason }`.
 *
 * @remarks
 * Takes the resolved `TunnelStore` service directly (the caller —
 * typically `useAppsHostBinding` — discharges it from the page's
 * livestore handle via `TunnelStore.layerFrom(store)` before calling).
 *
 * Replies ride {@link appsHostSenderRef} — the host→web sender
 * `useAppsHostBinding` captures from the transport's `onTransportReady`.
 * Handlers themselves stay pure `Effect<void>`; the proactive reply
 * goes through the captured sender rather than a same-bridge `send`.
 */
const makeAppsHostHandlers = (
  tunnelStore: TunnelStoreService
): MessageHandler.HandlersFor<(typeof AppsBridge)['WebToHost']> => ({
  RequestTunnel: () =>
    commitRequestedRunning(tunnelStore, true).pipe(
      Effect.andThen(awaitTunnelOrigin(tunnelStore)),
      Effect.matchCauseEffect({
        onSuccess: (origin) => reply({ _tag: 'TunnelStarted', origin }),
        onFailure: (cause) => reply({ _tag: 'TunnelFailed', reason: Cause.pretty(cause) }),
      })
    ),
})

export { makeAppsHostHandlers, setAppsHostSender }
export type { AppsHostSender }
