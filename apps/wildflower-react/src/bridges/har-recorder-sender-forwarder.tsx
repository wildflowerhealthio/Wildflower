import { HarRecorderSenderProvider } from 'har-recorder-react'

import { makeSliceSenderForwarder } from './make-sender-forwarder.tsx'

/**
 * Bridges the app's `BridgeTransport.sendMessage` into the HAR Recorder
 * slice's sender context, so the recorder page can fire `SaveHar` without
 * depending on the app-level transport directly. Mount inside a
 * `<TransportContext.Provider>` (the `app-root.tsx` `AppRoot` component
 * supplies one above `<RouterProvider>`).
 *
 * Separate from `CollectorSenderForwarder` because the recorder straddles two
 * bridges: its sniffer-event intake rides `CollectorBridge`, its filesystem
 * write rides `HarRecorderBridge`, and each has its own sender context.
 */
const HarRecorderSenderForwarder = makeSliceSenderForwarder(
  'HarRecorderSenderForwarder',
  HarRecorderSenderProvider
)

export { HarRecorderSenderForwarder }
