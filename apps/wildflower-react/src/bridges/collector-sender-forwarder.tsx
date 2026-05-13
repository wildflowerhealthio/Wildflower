import { type CollectorSender, CollectorSenderProvider } from 'collector-react'
import { type JSX, type ReactNode, useMemo } from 'react'

import { useBridgeTransport } from './transport-context.ts'

interface CollectorSenderForwarderProps {
  readonly children: ReactNode
}

/**
 * Bridges the app's `BridgeTransport.sendMessage` into the collector
 * slice's sender context — so collector-react screens can fire
 * `RequestSniffableWebView` / `SniffingComplete` without depending on
 * the app-level transport directly. Mount inside `<TransportProvider>`.
 *
 * The cast widens `transport.sendMessage` (a function-intersection over
 * every wired bridge's outbound message) to the slice's looser
 * `CollectorSender` (a single function accepting any tagged message
 * whose `_tag` is one of CollectorBridge's Web→Host tags). The dispatch
 * core routes by `_tag` at runtime regardless of the static signature.
 */
const CollectorSenderForwarder = ({ children }: CollectorSenderForwarderProps): JSX.Element => {
  const transport = useBridgeTransport()
  const send = useMemo<CollectorSender>(() => transport.sendMessage, [transport])
  return <CollectorSenderProvider send={send}>{children}</CollectorSenderProvider>
}

export { CollectorSenderForwarder }
