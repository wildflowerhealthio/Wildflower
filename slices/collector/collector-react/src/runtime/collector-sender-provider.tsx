import type { JSX, ReactNode } from 'react'

import { CollectorSenderContext, type CollectorSender } from './collector-sender-context.ts'

interface CollectorSenderProviderProps {
  /**
   * Function that dispatches a CollectorBridge Web→Host message —
   * typically `transport.sendMessage` from the app's BridgeTransport.
   */
  readonly send: CollectorSender
  readonly children: ReactNode
}

/**
 * Surfaces the app's `BridgeTransport.sendMessage` to collector-react
 * screens via {@link CollectorSenderContext}. Mounted *inside* the
 * app's `<TransportProvider>` so the transport is available; collector
 * screens read it via {@link useCollectorSender}.
 */
const CollectorSenderProvider = ({ send, children }: CollectorSenderProviderProps): JSX.Element => (
  <CollectorSenderContext.Provider value={send}>{children}</CollectorSenderContext.Provider>
)

export { CollectorSenderProvider }
export type { CollectorSenderProviderProps }
