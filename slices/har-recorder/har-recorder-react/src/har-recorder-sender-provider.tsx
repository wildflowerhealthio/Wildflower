import type { JSX, ReactNode } from 'react'

import { HarRecorderSenderContext, type HarRecorderSender } from './har-recorder-sender-context.ts'

interface HarRecorderSenderProviderProps {
  /**
   * Dispatches a `HarRecorderBridge` Web→Host message — typically
   * `transport.sendMessage` from the app's `BridgeTransport`.
   */
  readonly send: HarRecorderSender
  readonly children: ReactNode
}

/**
 * Surfaces the app's `BridgeTransport.sendMessage` to the recorder page via
 * {@link HarRecorderSenderContext}.
 *
 * @remarks
 * Mounted *inside* the app's `<TransportContext.Provider>` (the app's
 * `HarRecorderSenderForwarder` does this), so the transport is available; the
 * recorder reads it through {@link useHarRecorderSender}.
 */
const HarRecorderSenderProvider = ({
  send,
  children,
}: HarRecorderSenderProviderProps): JSX.Element => (
  <HarRecorderSenderContext.Provider value={send}>{children}</HarRecorderSenderContext.Provider>
)

export { HarRecorderSenderProvider }
export type { HarRecorderSenderProviderProps }
