import { AppsSenderProvider, type AppsSender } from 'apps-react'
import { type JSX, type ReactNode, useMemo } from 'react'

import { useBridgeTransport } from './transport-context.ts'

interface AppsSenderForwarderProps {
  readonly children: ReactNode
}

/**
 * Bridges the app's `BridgeTransport.sendMessage` into the apps
 * slice's sender context — so apps-react screens can fire
 * `RequestTunnel` without depending on the app-level transport
 * directly. Mount inside a `<TransportContext.Provider>` (the
 * `app-root.tsx` `AppRoot` component supplies one above
 * `<RouterProvider>`).
 *
 * The cast widens `transport.sendMessage` (a function-intersection over
 * every wired bridge's outbound message) to the slice's looser
 * `AppsSender` (a single function accepting any tagged message whose
 * `_tag` is one of AppsBridge's Web→Host tags). The dispatch core
 * routes by `_tag` at runtime regardless of the static signature.
 */
const AppsSenderForwarder = ({ children }: AppsSenderForwarderProps): JSX.Element => {
  const transport = useBridgeTransport()
  const send = useMemo<AppsSender>(() => transport.sendMessage, [transport])
  return <AppsSenderProvider send={send}>{children}</AppsSenderProvider>
}

export { AppsSenderForwarder }
