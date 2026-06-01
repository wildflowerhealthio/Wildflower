import { CollectorBridge } from 'collector-fundamentals/bridge'
import type { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import { Effect, type Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'

/**
 * The runtime holds the active sync's handler erased of its
 * `TResources` parameter: the receiver layer only needs the per-tag
 * Service methods, and the resources type travels via the handler's
 * own `onResult` closure rather than the call sites.
 *
 * The handler shape is `Service & { clear: () => void }` where
 * `Service` is the `HandlersFor<HostToWeb>` record (`ResponseStart`,
 * `ResponseData`, `ResponseFinished`, `RequestError`, `Cancelled`).
 */
type ActiveCollectorBridgeMessageHandler =
  CollectorBridgeMessageHandler.CollectorBridgeMessageHandler<unknown>

/**
 * Module-level cell holding the active sync's handler (or `null` when
 * idle). Mirrors the gatekeeper slice's `authTokenRef` pattern: the
 * page builds its `BridgeTransport` once at boot and the
 * `collectorWebReceiverLayer` below closes over this cell, so the
 * transport build does not depend on the React tree.
 *
 * Singleton by design — the page has exactly one transport, exactly
 * one running sync at a time. Last writer wins; `useSyncRunner`
 * installs its handler on mount and clears it on unmount via
 * {@link clearActiveHandlerIfCurrent} (set-if-equal) so a delayed
 * cleanup can't blank a fresher handler that just took the slot.
 *
 * See the [Singleton Bridge Refs Explanation](../../../../../docs/Effect/Singleton%20Bridge%20Refs%20Explanation.md)
 * for the runtime-singleton invariant this enforces and its
 * implications for StrictMode, HMR, and test isolation.
 */
const activeHandlerRef: { current: ActiveCollectorBridgeMessageHandler | null } = { current: null }

const droppedTagWarning = (tag: string): Effect.Effect<void> =>
  Effect.logWarning(
    `collectorWebReceiverLayer: dropping ${tag} — no active CollectorBridgeMessageHandler`
  )

/**
 * `CollectorBridge.Web` `ReceiverLayer` the app's transport build
 * supplies to `BridgeTransport.make`. Reads {@link activeHandlerRef}
 * on every Host→Web tag and forwards into the installed handler's
 * matching method (or log-and-drops when nothing is installed).
 */
const collectorWebReceiverLayer: Layer.Layer<MessageHandler.TagId<'Collector', 'Web'>> =
  CollectorBridge.Web.ReceiverLayer({
    ResponseStart: (event) => {
      const h = activeHandlerRef.current
      return h === null ? droppedTagWarning('ResponseStart') : h.ResponseStart(event)
    },
    ResponseData: (event) => {
      const h = activeHandlerRef.current
      return h === null ? droppedTagWarning('ResponseData') : h.ResponseData(event)
    },
    ResponseFinished: (event) => {
      const h = activeHandlerRef.current
      return h === null ? droppedTagWarning('ResponseFinished') : h.ResponseFinished(event)
    },
    RequestError: (event) => {
      const h = activeHandlerRef.current
      return h === null ? droppedTagWarning('RequestError') : h.RequestError(event)
    },
    Cancelled: (event) => {
      const h = activeHandlerRef.current
      return h === null ? droppedTagWarning('Cancelled') : h.Cancelled(event)
    },
    PageLoaded: (event) => {
      const h = activeHandlerRef.current
      return h === null ? droppedTagWarning('PageLoaded') : h.PageLoaded(event)
    },
  })

const setActiveHandler = (handler: ActiveCollectorBridgeMessageHandler | null): void => {
  activeHandlerRef.current = handler
}

/**
 * Set-if-equal clear. Only blanks {@link activeHandlerRef} when it
 * still points at the supplied `handler`. Callers (cleanup paths in
 * `useSyncRunner`) use this in place of `setActiveHandler(null)` so a
 * cleanup that runs after a successor handler has already taken the
 * slot — possible under StrictMode double-mount or any async-tinged
 * cleanup ordering — does not blank out the live handler.
 */
const clearActiveHandlerIfCurrent = (handler: ActiveCollectorBridgeMessageHandler): void => {
  if (activeHandlerRef.current === handler) {
    activeHandlerRef.current = null
  }
}

export { clearActiveHandlerIfCurrent, collectorWebReceiverLayer, setActiveHandler }
export type { ActiveCollectorBridgeMessageHandler }
