import { CollectorSenderProvider } from 'collector-react'

import { makeSliceSenderForwarder } from './make-sender-forwarder.tsx'

/**
 * Bridges the app's `BridgeTransport.sendMessage` into the collector
 * slice's sender context — so collector-react screens can fire
 * `Open` / `SniffingComplete` without depending on
 * the app-level transport directly. Mount inside a
 * `<TransportContext.Provider>` (the `app-root.tsx` `AppRoot` component
 * supplies one above `<RouterProvider>`).
 */
const CollectorSenderForwarder = makeSliceSenderForwarder(
  'CollectorSenderForwarder',
  CollectorSenderProvider
)

export { CollectorSenderForwarder }
