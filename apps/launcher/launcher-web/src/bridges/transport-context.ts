import type { BridgeTransport } from '@wildflowerhealthio/effect-messaging-core'
import type { HandlerCoordinator } from '@wildflowerhealthio/effect-messaging-react'
import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import { Effect } from 'effect'
import { createContext } from 'react'

import type { Bridges } from './bridges.ts'

/**
 * The page-side transport surface React consumers see — `sendMessage`
 * plus the {@link HandlerCoordinator} (so slices register their inbound
 * handlers on mount).
 */
interface ReactTransport {
  readonly sendMessage: BridgeTransport.MessageSender<Bridges, 'WebToHost'>
  readonly coordinator: HandlerCoordinator
}

/**
 * No-op transport used by standalone-web entries and as the
 * pre-resolution placeholder for `<TransportContext>` while the real
 * transport's `__Ready` handshake is in flight. Its
 * `sendMessage` is `Effect.void`, so emits during that window are
 * dropped (which is correct — the host isn't ready to receive yet).
 * The `_auth` gate's `awaitAuthReady` waits the bridge handshake before
 * any consumer that needs a real sender renders.
 */
const stubTransport: ReactTransport = {
  sendMessage: () => Effect.void,
  coordinator: {
    register: () => Effect.void,
    unregister: () => Effect.void,
  },
}

const TransportContext = createContext<ReactTransport | null>(null)
TransportContext.displayName = 'TransportContext'

/**
 * Hook for components that need to send messages to the host.
 *
 * @throws `NoContextException` if no `<TransportContext.Provider>` mounts above.
 */
const useBridgeTransport = (): ReactTransport => useContextOrThrow(TransportContext)

export { stubTransport, TransportContext, useBridgeTransport }
export type { ReactTransport }
