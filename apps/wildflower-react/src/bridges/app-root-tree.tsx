import { type AnyRouter, RouterProvider } from '@tanstack/react-router'
import type { Bridge } from 'effect-messaging-core'
import { type HandlerCoordinator, HandlerCoordinatorContext } from 'effect-messaging-react'
import { NavigationBridgeHandler } from 'navigation-react'
import { Fragment, type JSX } from 'react'
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
 * transport's `sendMessage`.
 */
const AppRootTree = ({ router, transportPromise }: AppRootTreeProps): JSX.Element => {
  const transport = usePromiseOrDefault(transportPromise, stubTransport, () => stubTransport)
  // The context is generic-erased so a single React context node serves
  // every slice's narrowed `useHandlerCoordinator<...>()` call. The
  // runtime coordinator is bridge-name-keyed and direction-agnostic, so
  // widening the type for storage is sound.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const erased = transport.coordinator as unknown as HandlerCoordinator<
    ReadonlyArray<Bridge.AnyBridge>,
    Bridge.Direction
  >

  return (
    <TransportContext.Provider value={transport}>
      <HandlerCoordinatorContext.Provider value={erased}>
        <RouterProvider
          router={router}
          InnerWrap={({ children }) => (
            <Fragment>
              {/*
               * NavigationBridgeHandler only needs `transport.sendMessage`
               * (not the slice senders), so it sits beside the forwarders
               * rather than buried inside them.
               */}
              <NavigationBridgeHandler sender={transport.sendMessage} />
              <CollectorSenderForwarder>
                <AppsSenderForwarder>{children}</AppsSenderForwarder>
              </CollectorSenderForwarder>
            </Fragment>
          )}
        />
      </HandlerCoordinatorContext.Provider>
    </TransportContext.Provider>
  )
}

export { AppRootTree }
export type { AppRootTreeProps }
