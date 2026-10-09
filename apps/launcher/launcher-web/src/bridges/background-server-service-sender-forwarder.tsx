import { BackgroundServerServiceSenderProvider } from 'wildflower-server-react'

import { makeSliceSenderForwarder } from './make-sender-forwarder.tsx'

/**
 * Bridges the app's `BridgeTransport.sendMessage` into the background server
 * service's sender context, so the server status banner and the
 * `/settings/server` page can send `RestartServer` without depending on the
 * app-level transport. Mount inside a `<TransportContext.Provider>`.
 */
const BackgroundServerServiceSenderForwarder = makeSliceSenderForwarder(
  'BackgroundServerServiceSenderForwarder',
  BackgroundServerServiceSenderProvider
)

export { BackgroundServerServiceSenderForwarder }
