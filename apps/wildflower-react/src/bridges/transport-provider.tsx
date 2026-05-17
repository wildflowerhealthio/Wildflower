import AppsBridge from 'apps-core/bridge'
import { useAppsWebReceiverLayer } from 'apps-react'
import CollectorBridge from 'collector-fundamentals/bridge'
import { useCollectorWebReceiverLayer } from 'collector-react'
import { Effect, Exit, Layer, Scope } from 'effect'
import { BridgeTransport, TransportAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebReceiverLayer, NavigationBridgeHandler } from 'navigation-react'
import { type JSX, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { Await, useNavigate } from 'react-router'
import { TransportContext, type Transport } from './transport-context.ts'

/**
 * Build the page-side `BridgeTransport` once at mount, with the
 * navigation receiver Layer closing over `useNavigate()` and the
 * collector receiver Layer pulled from `<CollectorRuntimeProvider>`.
 * Suspends `children` rendering until the dispatch fiber drains every
 * URL-encoded initial message (`transport.flushed`); then posts
 * `__Ready` to the host so its outbound queue can flow. The dispatch
 * fiber's scope tears down on unmount.
 *
 * @remarks
 * `useNavigate()` is captured behind a ref so the receiver Layer's
 * handlers always see the latest navigate function without re-building
 * the transport on every render.
 *
 * The render-block — `children` is replaced by `loader` (or `null`)
 * until drain — is what removes the need for a synchronous initial-path
 * peek. The router mounts at its default entry; the URL's
 * `HostRequestedWebNavigation` flows through the same dispatch path as
 * runtime navigations and the navigation handler calls `navigate(path)`
 * during bootstrap. One mechanism for every initial message.
 */
function TransportProvider({
  children,
  loader = null,
}: {
  readonly children: ReactNode
  readonly loader?: ReactNode
}): JSX.Element {
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  // Collector's receiver layer closes over the React-tree-bound
  // active-handler ref inside <CollectorRuntimeProvider>. The provider
  // mounts above this one in main-{web,embedded}.
  const collectorLayer = useCollectorWebReceiverLayer()
  // Apps' receiver layer closes over the React-tree-bound
  // pending-tunnel-resolver ref inside <AppsRuntimeProvider>. The
  // provider mounts above this one in main-{web,embedded}.
  const appsLayer = useAppsWebReceiverLayer()

  const [scope] = useState(() => Effect.runSync(Scope.make()))
  const [transportPromise] = useState<Promise<Transport>>(() => {
    const navLayer = makeNavigationWebReceiverLayer((to) => {
      // Split branches so React Router's `navigate` overload picks the right signature.
      if (typeof to === 'number') void navigateRef.current(to)
      else void navigateRef.current(to)
    })
    const bridges = [NavigationBridge, GatekeeperBridge, CollectorBridge, AppsBridge] as const
    const adapter = WebPlatformAdapter.make(bridges)
    return Effect.runPromise(
      Scope.extend(
        BridgeTransport.make({
          bridges,
          layers: [navLayer, gatekeeperWebReceiverLayer, collectorLayer, appsLayer] as const,
          side: 'Web',
        }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter))),
        scope
      )
    ).then(async (transport) => {
      await Effect.runPromise(Effect.andThen(transport.flushed, transport.signalReady))

      console.log = (...args) => {
        transport.sendMessage({
          _tag: 'Log',
          log: JSON.stringify(args),
        })
      }

      console.error = (...args) => {
        transport.sendMessage({
          _tag: 'Log',
          log: JSON.stringify(args),
        })
      }

      console.warn = (...args) => {
        transport.sendMessage({
          _tag: 'Log',
          log: JSON.stringify(args),
        })
      }
      console.info = (...args) => {
        transport.sendMessage({
          _tag: 'Log',
          log: JSON.stringify(args),
        })
      }

      return transport
    })
  })

  useEffect(() => {
    return (): void => {
      Effect.runFork(Scope.close(scope, Exit.void))
    }
  }, [scope])

  // Only display the body once the transport has been flushed and
  // any initial navigations have completed, to prevent a flashing ui
  return (
    <Suspense fallback={loader}>
      <Await resolve={transportPromise}>
        {(transport) => (
          <TransportContext.Provider value={transport}>
            <NavigationBridgeHandler sender={transport.sendMessage} />
            {children}
          </TransportContext.Provider>
        )}
      </Await>
    </Suspense>
  )
}

export { TransportProvider }
