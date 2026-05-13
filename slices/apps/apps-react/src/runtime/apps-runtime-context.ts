import type AppsBridge from 'apps-core/bridge'
import type { Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { createContext } from 'react'

/**
 * The tunnel-response outcomes the apps runtime resolves a pending
 * `useRequestTunnel` call with. Mirrors the AppsBridge Host→Web
 * messages — `_tag: 'TunnelStarted'` carries the new origin, `_tag:
 * 'TunnelFailed'` carries a human-readable reason — flattened into the
 * shape callers actually observe (`{ origin } | { error }`).
 */
type TunnelOutcome = { readonly origin: string } | { readonly error: string }

/**
 * Stashes the in-flight tunnel-request resolver (or `null` when no
 * request is pending). The receiver layer reads this on every
 * `TunnelStarted` / `TunnelFailed` Host→Web message and forwards the
 * outcome to whichever caller is waiting. Set inside
 * `<AppsRuntimeProvider>` via a ref; `useRequestTunnel` swaps a fresh
 * resolver in for the duration of each request.
 */
interface AppsRuntimeContextValue {
  readonly setPendingTunnelResolver: (resolver: ((outcome: TunnelOutcome) => void) | null) => void
  /**
   * Prebuilt `AppsBridge.Web` `ReceiverLayer` the app's
   * TransportProvider supplies to `BridgeTransport.make`. Reads the
   * current resolver ref on each Host→Web tag.
   */
  readonly receiverLayer: Layer.Layer<MessageHandler.TagId<typeof AppsBridge.name, 'Web'>>
}

const AppsRuntimeContext = createContext<AppsRuntimeContextValue | null>(null)

export { AppsRuntimeContext }
export type { AppsRuntimeContextValue, TunnelOutcome }
