import type AppsBridge from 'apps-core/bridge'
import type CollectorBridge from 'collector-fundamentals/bridge'
import type { BridgeTransport, LogBridge } from 'effect-messaging-core'
import type GatekeeperBridge from 'gatekeeper-core/bridge'
import type { NavigationBridge } from 'navigation-core'
import { createContext, useContext } from 'react'

type Bridges = readonly [
  typeof NavigationBridge,
  typeof GatekeeperBridge,
  typeof CollectorBridge,
  typeof AppsBridge,
  typeof LogBridge.LogBridge,
]
type Transport = BridgeTransport.BridgeTransport<Bridges, 'Web'>

const TransportContext = createContext<Transport | null>(null)

/**
 * Hook for components that need to send messages to the host.
 *
 * @throws if called outside a `<TransportProvider>`.
 */
const useBridgeTransport = (): Transport => {
  const ctx = useContext(TransportContext)
  if (ctx === null) throw new Error('useBridgeTransport called outside TransportProvider')
  return ctx
}

export { TransportContext, useBridgeTransport }
export type { Transport }
