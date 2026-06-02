import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import type { HandlerCoordinator } from 'effect-messaging-react'
import { createContext } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

import type { Bridges } from './bridges.ts'

type FullTransport = BridgeTransport.BridgeTransport<Bridges, 'HostToWeb', 'WebToHost'>

/**
 * Narrowed view of `BridgeTransport` that React-side consumers see —
 * `sendMessage` plus the {@link HandlerCoordinator} (so slices register
 * their inbound handlers on mount). `signalReady`/`enqueue`/the raw
 * `registerHandlers` stay boot-time / Effect-side concerns that
 * {@link AppRootTree} drives off the resolved transport; the coordinator
 * wraps `registerHandlers` with per-bridge recompose so React consumers
 * never touch it directly.
 */
interface ReactTransport {
  readonly sendMessage: FullTransport['sendMessage']
  readonly coordinator: HandlerCoordinator
}

/**
 * No-op transport used by standalone-web entries and as the
 * pre-resolution placeholder for `<TransportContext>` while the real
 * embedded transport's `signalReady` handshake is in flight. Its
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
