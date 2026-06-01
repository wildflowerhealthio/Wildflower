import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import { NavigationBridgeHandler } from 'navigation-react'
import { type JSX } from 'react'
import { usePromiseOrDefault } from 'react-kitchen-sink'

import { AppsSenderForwarder } from './apps-sender-forwarder.tsx'
import { CollectorSenderForwarder } from './collector-sender-forwarder.tsx'
import { stubTransport, TransportContext, type ReactTransport } from './transport-context.ts'

interface AppRootTreeProps {
  readonly router: AnyRouter
  readonly transportPromise: Promise<ReactTransport>
}

/**
 * Owns the `transport` state seeded by `transportPromise`. Until the
 * promise resolves, `TransportContext` holds the `stubTransport`
 * (no-op sender) so the sender-forwarders below render without
 * crashing. The `_auth` gate's `awaitAuthReady` waits the bridge
 * handshake before any consumer that needs a *real* sender renders, so
 * the brief stub window has no live subscribers other than the
 * navigation watcher.
 *
 * `NavigationBridgeHandler` is rendered unconditionally — it observes
 * `useLocation()` and emits `RouteChanged` through the current
 * transport's `sendMessage`. The narrowed `ReactTransport` keeps
 * `sendMessage` typed even before the real transport lands, so any
 * pre-resolve emission is dropped by the stub (correct: the host
 * isn't ready to receive yet) and post-resolve emissions ride the live
 * transport.
 */
const AppRootTree = ({ router, transportPromise }: AppRootTreeProps): JSX.Element => {
  const transport = usePromiseOrDefault(transportPromise, stubTransport, () => stubTransport)

  return (
    <TransportContext.Provider value={transport}>
      <RouterProvider
        router={router}
        InnerWrap={({ children }) => (
          <CollectorSenderForwarder>
            <AppsSenderForwarder>
              <NavigationBridgeHandler sender={transport.sendMessage} />
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
