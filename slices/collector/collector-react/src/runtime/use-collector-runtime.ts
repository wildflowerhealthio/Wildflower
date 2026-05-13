import { useContext } from 'react'

import {
  CollectorRuntimeContext,
  type CollectorRuntimeContextValue,
} from './collector-runtime-context.ts'

const useCollectorRuntime = (): CollectorRuntimeContextValue => {
  const value = useContext(CollectorRuntimeContext)
  if (value === null) {
    throw new Error('useCollectorRuntime must be used inside <CollectorRuntimeProvider>')
  }
  return value
}

/**
 * The CollectorBridge `Web` ReceiverLayer the app's TransportProvider
 * supplies to `BridgeTransport.make`. Reads from
 * `<CollectorRuntimeProvider>` so the layer's tag handlers close over
 * the same active-handler ref the running sync installs into.
 */
const useCollectorWebReceiverLayer = (): CollectorRuntimeContextValue['receiverLayer'] =>
  useCollectorRuntime().receiverLayer

export { useCollectorRuntime, useCollectorWebReceiverLayer }
