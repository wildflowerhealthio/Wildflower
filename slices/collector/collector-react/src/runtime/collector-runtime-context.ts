import type { CollectorBridgeMessageHandler } from 'collector-fundamentals/handler'
import type { Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { createContext } from 'react'

/**
 * The runtime holds the active sync's handler erased of its
 * `TResources` parameter: the receiver layer only needs the per-tag
 * Service methods, and the resources type travels via the handler's
 * own `onResult` closure rather than the call sites.
 *
 * The handler shape is `Service & { clear: () => void }` where
 * `Service` is the `HandlersFor<HostToWeb>` record (`ResponseStart`,
 * `ResponseData`, `ResponseFinished`, `RequestError`, `Cancelled`).
 * `CollectorBridgeMessageHandler.CollectorBridgeMessageHandler<unknown>`
 * names that shape — the inner type alias re-exported via the namespace
 * pattern from `collector-fundamentals/handler`.
 */
type ActiveCollectorBridgeMessageHandler =
  CollectorBridgeMessageHandler.CollectorBridgeMessageHandler<unknown>

/**
 * Shape provided by `<CollectorRuntimeProvider>`: a setter the running
 * sync uses to install / clear its `CollectorBridgeMessageHandler`,
 * plus the prebuilt `CollectorBridge.Web.ReceiverLayer` the app's
 * TransportProvider consumes when assembling its `BridgeTransport`.
 *
 * The active handler lives in a ref inside the provider; the receiver
 * layer reads that ref on each tag and forwards into the installed
 * handler's matching method (or logs-and-drops when nothing is
 * installed). React-tree-bound — HMR / remount cycles produce a fresh
 * ref and a fresh layer; module-level singletons are deliberately
 * avoided.
 */
interface CollectorRuntimeContextValue {
  readonly setActiveHandler: (handler: ActiveCollectorBridgeMessageHandler | null) => void
  readonly receiverLayer: Layer.Layer<MessageHandler.TagId<'Collector', 'Web'>>
}

const CollectorRuntimeContext = createContext<CollectorRuntimeContextValue | null>(null)

export { CollectorRuntimeContext }
export type { ActiveCollectorBridgeMessageHandler, CollectorRuntimeContextValue }
