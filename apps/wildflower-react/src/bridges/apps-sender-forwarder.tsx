import { AppsSenderProvider } from 'apps-react'

import { makeSliceSenderForwarder } from './make-sender-forwarder.tsx'

/**
 * Bridges the app's `BridgeTransport.sendMessage` into the apps slice's
 * sender context — so apps-react screens can fire `RequestTunnel`
 * without depending on the app-level transport directly. Mount inside a
 * `<TransportContext.Provider>` (the `app-root.tsx` `AppRoot` component
 * supplies one above `<RouterProvider>`).
 */
const AppsSenderForwarder = makeSliceSenderForwarder('AppsSenderForwarder', AppsSenderProvider)

export { AppsSenderForwarder }
