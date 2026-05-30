import type { AppsBridge } from 'apps-core/bridge'
import type { CollectorBridge } from 'collector-fundamentals/bridge'
import { Effect } from 'effect'
import type { BridgeTransport, Logging } from 'effect-messaging-core'
import type { GatekeeperBridge } from 'gatekeeper-core/bridge'
import type { NavigationBridge } from 'navigation-core'
import { createContext, useContext } from 'react'

type Bridges = readonly [
  typeof NavigationBridge,
  typeof GatekeeperBridge,
  typeof CollectorBridge,
  typeof AppsBridge,
  typeof Logging.LogBridge,
]
type Transport = BridgeTransport.BridgeTransport<Bridges, 'Web'>

/**
 * No-op transport used by standalone-web entries and as the
 * pre-resolution placeholder for `<TransportContext>` while the real
 * embedded transport's `flushed → signalReady` chain is in flight. Its
 * `sendMessage` is `Effect.void`, so emits during that window are
 * dropped (which is correct — the host isn't ready to receive yet).
 * The `_auth` gate awaits `transportReady` before any consumer that
 * needs a real sender renders.
 */
const stubTransport: Transport = {
  sendMessage: () => Effect.void,
  flushed: Effect.void,
  enqueue: () => Effect.void,
  signalReady: Effect.void,
}

const TransportContext = createContext<Transport | null>(null)

/**
 * Hook for components that need to send messages to the host.
 *
 * @throws if no `<TransportContext.Provider>` mounts above.
 */
const useBridgeTransport = (): Transport => {
  const ctx = useContext(TransportContext)
  if (ctx === null) throw new Error('useBridgeTransport called outside a TransportContext provider')
  return ctx
}

export { stubTransport, TransportContext, useBridgeTransport }
export type { Transport }
