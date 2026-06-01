import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { createContext, useContext } from 'react'

import type { Bridges } from './bridges.ts'

type FullTransport = BridgeTransport.BridgeTransport<Bridges, 'Web'>

/**
 * Narrowed view of `BridgeTransport` that React-side consumers see. The
 * components below the `TransportContext.Provider` only ever need to
 * send messages — `signalReady`, `enqueue`, `registerHandlers` are
 * boot-time / Effect-side concerns that {@link AppRootTree} drives
 * directly off the resolved transport. Narrowing here means the stub
 * doesn't have to grow every time the underlying transport gains a new
 * method.
 */
interface ReactTransport {
  readonly sendMessage: FullTransport['sendMessage']
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
}

const TransportContext = createContext<ReactTransport | null>(null)

/**
 * Hook for components that need to send messages to the host.
 *
 * @throws if no `<TransportContext.Provider>` mounts above.
 */
const useBridgeTransport = (): ReactTransport => {
  const ctx = useContext(TransportContext)
  if (ctx === null) throw new Error('useBridgeTransport called outside a TransportContext provider')
  return ctx
}

export { stubTransport, TransportContext, useBridgeTransport }
export type { FullTransport, ReactTransport }
