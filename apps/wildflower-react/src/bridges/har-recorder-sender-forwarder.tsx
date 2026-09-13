import { HarRecorderSenderProvider } from 'har-recorder-react'

import { makeSliceSenderForwarder } from './make-sender-forwarder.tsx'

/**
 * Bridges the app's `BridgeTransport.sendMessage` into the HAR Recorder slice's
 * sender context, so the recorder page can fire `SaveHar` without depending on
 * the app-level transport. Mount inside a `<TransportContext.Provider>`.
 *
 * Separate from `CollectorSenderForwarder` because the recorder straddles two
 * bridges, each with its own sender context.
 */
const HarRecorderSenderForwarder = makeSliceSenderForwarder(
  'HarRecorderSenderForwarder',
  HarRecorderSenderProvider
)

export { HarRecorderSenderForwarder }
