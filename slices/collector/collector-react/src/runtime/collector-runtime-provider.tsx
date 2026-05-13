import CollectorBridge from 'collector-fundamentals/bridge'
import { Effect } from 'effect'
import { useMemo, useRef, type JSX, type ReactNode } from 'react'

import {
  CollectorRuntimeContext,
  type ActiveCollectorBridgeMessageHandler,
  type CollectorRuntimeContextValue,
} from './collector-runtime-context.ts'

interface CollectorRuntimeProviderProps {
  readonly children: ReactNode
}

const droppedTagWarning = (tag: string): Effect.Effect<void> =>
  Effect.logWarning(
    `CollectorRuntimeProvider: dropping ${tag} — no active CollectorBridgeMessageHandler`
  )

/**
 * Owns the active `CollectorBridgeMessageHandler` ref the running sync
 * installs into, and exports a memoised `receiverLayer` that forwards
 * every Host→Web collector tag into whatever handler is currently
 * installed. The app's transport provider plumbs the receiver layer
 * into `BridgeTransport.make`.
 *
 * Mount *above* the app's `<TransportProvider>` so the transport can
 * read the receiver layer when it builds.
 *
 * No event bus and no module-level singletons: when nothing is
 * installed (idle SPA) the layer log-and-drops; when a sync mounts
 * `useSyncRunner` it sets the ref to its `CollectorBridgeMessageHandler.make`
 * result; on unmount it clears the ref.
 */
const CollectorRuntimeProvider = ({ children }: CollectorRuntimeProviderProps): JSX.Element => {
  const activeHandlerRef = useRef<ActiveCollectorBridgeMessageHandler | null>(null)

  const value = useMemo<CollectorRuntimeContextValue>(
    () => ({
      setActiveHandler: (handler) => {
        activeHandlerRef.current = handler
      },
      receiverLayer: CollectorBridge.Web.ReceiverLayer({
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
      }),
    }),
    []
  )

  return (
    <CollectorRuntimeContext.Provider value={value}>{children}</CollectorRuntimeContext.Provider>
  )
}

export { CollectorRuntimeProvider }
export type { CollectorRuntimeProviderProps }
