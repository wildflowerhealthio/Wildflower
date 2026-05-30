import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { NavigationBridgeHandler } from 'navigation-react'
import { useEffect, useState, type JSX } from 'react'

import { AppsSenderForwarder } from './apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from './collector-sender-forwarder.tsx'
import { stubTransport, TransportContext, type Transport } from './transport-context.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  readonly transportPromise: Promise<Transport>
}

/**
 * Owns the `transport` state seeded by `transportPromise`. Until the
 * promise resolves, `TransportContext` holds the `stubTransport`
 * (no-op sender) so the sender-forwarders below render without
 * crashing. The `_auth` gate awaits `transportReady` before any
 * authed subtree renders, so consumers that need a *real* sender
 * (`UIReadyEmitter`, slice screens) never observe the stub.
 *
 * `NavigationBridgeHandler` is gated on the real transport so its
 * initial `RouteChanged` fires *after* `transport.signalReady` and is
 * delivered, not absorbed by the stub.
 */
const AppRootTree = ({ router, transportPromise }: AppRootTreeProps): JSX.Element => {
  const [transport, setTransport] = useState<Transport | null>(null)

  useEffect(() => {
    let cancelled = false
    void transportPromise.then((t) => {
      if (!cancelled) setTransport(t)
    })
    return (): void => {
      cancelled = true
    }
  }, [transportPromise])

  return (
    <TransportContext.Provider value={transport ?? stubTransport}>
      <RouterProvider
        router={router}
        InnerWrap={({ children }) => (
          <CollectorSenderForwarder>
            <AppsSenderForwarder>
              {transport !== null && <NavigationBridgeHandler sender={transport.sendMessage} />}
              {children}
            </AppsSenderForwarder>
          </CollectorSenderForwarder>
        )}
      />
    </TransportContext.Provider>
  )
}

export { AppRootTree }
export type { AppRootTreeProps }
