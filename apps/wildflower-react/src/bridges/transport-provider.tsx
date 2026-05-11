import { Effect, Exit, Layer, Scope } from 'effect'
import { BridgeTransport, TransportAdapter } from 'effect-messaging-core'
import { WebPlatformAdapter } from 'effect-messaging-react'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebReceiverLayer, NavigationBridgeHandler } from 'navigation-react'
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { TransportContext, type Transport } from './transport-context.ts'

/**
 * Build the page-side `BridgeTransport` once at mount, with the
 * navigation receiver Layer closing over `useNavigate()`. Suspends
 * `children` rendering until the dispatch fiber drains every URL-encoded
 * initial message (`transport.flushed`); then posts `__Ready` to the
 * host so its outbound queue can flow. The dispatch fiber's scope tears
 * down on unmount.
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

  const [scope] = useState(() => Effect.runSync(Scope.make()))
  const [transport] = useState<Transport>(() => {
    const navLayer = makeNavigationWebReceiverLayer((to) => {
      // Split branches so React Router's `navigate` overload picks the right signature.
      if (typeof to === 'number') void navigateRef.current(to)
      else void navigateRef.current(to)
    })
    const bridges = [NavigationBridge, GatekeeperBridge] as const
    const adapter = WebPlatformAdapter.make(bridges)
    return Effect.runSync(
      Scope.extend(
        BridgeTransport.make({
          bridges,
          layers: [navLayer, gatekeeperWebReceiverLayer] as const,
          side: 'Web',
        }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter))),
        scope
      )
    )
  })

  const [initialTransportMessagesFlushed, setInitialTransportMessagesFlushed] = useState(false)

  useEffect(() => {
    Effect.runFork(
      transport.flushed.pipe(
        Effect.tap(() => Effect.sync(() => setInitialTransportMessagesFlushed(true))),
        Effect.zipRight(transport.signalReady)
      )
    )
    return (): void => {
      Effect.runFork(Scope.close(scope, Exit.void))
    }
  }, [transport, scope])

  // Only display the body once the transport has been flushed and
  // any initial navigations have completed, to prevent a flashing ui
  if (initialTransportMessagesFlushed) {
    return (
      <TransportContext.Provider value={transport}>
        <NavigationBridgeHandler sender={transport.sendMessage} />
        {children}
      </TransportContext.Provider>
    )
  } else {
    return <>{loader}</>
  }
}

export { TransportProvider }
