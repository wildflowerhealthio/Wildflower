import type { CollectorBridge } from 'collector-fundamentals/bridge'
import type { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import { MessageHandler, type Bridge } from 'effect-messaging-core'

/**
 * The runtime holds the active sync's handler erased of its
 * `TResources` parameter: the handler record only needs the per-tag
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
 * page builds its `BridgeTransport` once at boot and the record
 * {@link makeCollectorWebHandlers} returns closes over this cell, so the
 * transport build does not depend on the React tree.
 *
 * Exported so the sole writer (`useSyncRunner`) can install its handler
 * with a direct `activeHandlerRef.current = handler` on mount and clear
 * it on unmount via {@link clearActiveHandlerIfCurrent} (set-if-equal),
 * so a delayed cleanup can't blank a fresher handler that just took the
 * slot.
 *
 * Singleton by design — the page has exactly one transport, exactly
 * one running sync at a time. Last writer wins.
 *
 * See the [Singleton Bridge Refs Explanation](../../../../../docs/Effect/Singleton%20Bridge%20Refs%20Explanation.md)
 * for the runtime-singleton invariant this enforces and its
 * implications for StrictMode, HMR, and test isolation.
 */
const activeHandlerRef: { current: ActiveCollectorBridgeMessageHandler | null } = { current: null }

/**
 * Build the `CollectorBridge.Web` inbound handler record the app's
 * transport build supplies to `BridgeTransport.make`. Each per-tag
 * handler reads {@link activeHandlerRef} on every Host→Web tag and
 * forwards into the installed handler's matching method (or
 * log-and-drops when nothing is installed).
 */
const makeCollectorWebHandlers = (): Bridge.HalfHandlers<(typeof CollectorBridge)['Web']> => ({
  ResponseStart: (event) => {
    const h = activeHandlerRef.current
    return h === null
      ? MessageHandler.droppedTagWarning('collectorWebHandlers', 'ResponseStart')
      : h.ResponseStart(event)
  },
  ResponseData: (event) => {
    const h = activeHandlerRef.current
    return h === null
      ? MessageHandler.droppedTagWarning('collectorWebHandlers', 'ResponseData')
      : h.ResponseData(event)
  },
  ResponseFinished: (event) => {
    const h = activeHandlerRef.current
    return h === null
      ? MessageHandler.droppedTagWarning('collectorWebHandlers', 'ResponseFinished')
      : h.ResponseFinished(event)
  },
  RequestError: (event) => {
    const h = activeHandlerRef.current
    return h === null
      ? MessageHandler.droppedTagWarning('collectorWebHandlers', 'RequestError')
      : h.RequestError(event)
  },
  Cancelled: (event) => {
    const h = activeHandlerRef.current
    return h === null
      ? MessageHandler.droppedTagWarning('collectorWebHandlers', 'Cancelled')
      : h.Cancelled(event)
  },
  PageLoaded: (event) => {
    const h = activeHandlerRef.current
    return h === null
      ? MessageHandler.droppedTagWarning('collectorWebHandlers', 'PageLoaded')
      : h.PageLoaded(event)
  },
})

/**
 * Set-if-equal clear. Only blanks {@link activeHandlerRef} when it
 * still points at the supplied `handler`. Callers (cleanup paths in
 * `useSyncRunner`) use this in place of `activeHandlerRef.current = null`
 * so a cleanup that runs after a successor handler has already taken the
 * slot — possible under StrictMode double-mount or any async-tinged
 * cleanup ordering — does not blank out the live handler.
 */
const clearActiveHandlerIfCurrent = (handler: ActiveCollectorBridgeMessageHandler): void => {
  if (activeHandlerRef.current === handler) {
    activeHandlerRef.current = null
  }
}

export { activeHandlerRef, clearActiveHandlerIfCurrent, makeCollectorWebHandlers }
export type { ActiveCollectorBridgeMessageHandler }
