import { useContext } from 'react'

import { AppsRuntimeContext, type AppsRuntimeContextValue } from './apps-runtime-context.ts'

const useAppsRuntime = (): AppsRuntimeContextValue => {
  const value = useContext(AppsRuntimeContext)
  if (value === null) {
    throw new Error('useAppsRuntime must be used inside <AppsRuntimeProvider>')
  }
  return value
}

/**
 * The AppsBridge `Web` ReceiverLayer the app's TransportProvider
 * supplies to `BridgeTransport.make`. Reads from
 * `<AppsRuntimeProvider>` so the layer's tag handlers close over the
 * same pending-resolver ref `useRequestTunnel` installs into.
 */
const useAppsWebReceiverLayer = (): AppsRuntimeContextValue['receiverLayer'] =>
  useAppsRuntime().receiverLayer

export { useAppsRuntime, useAppsWebReceiverLayer }
