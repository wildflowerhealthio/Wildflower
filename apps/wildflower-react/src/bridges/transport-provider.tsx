import { Effect, Exit, Layer, Scope } from 'effect'
import { BridgeTransport, TransportAdapter } from 'effect-messaging-core'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { gatekeeperWebReceiverLayer } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebReceiverLayer, NavigationBridgeHandler } from 'navigation-react'
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { TransportContext, type Transport } from './transport-context.ts'
import { replayAdapter } from './transport.ts'

/**
 * Build the page-side `BridgeTransport` once at mount, with the
 * navigation receiver Layer closing over `useNavigate()`. Posts
 * `__Ready` to the host once the receivers are wired (via
 * `transport.signalReady`), then provides the transport to descendants
 * through context. The dispatch fiber's scope tears down on unmount.
 *
 * @remarks
 * `useNavigate()` is captured behind a ref so the receiver Layer's
 * handlers always see the latest navigate function without
 * re-building the transport on every render.
 */
function TransportProvider({ children }: { readonly children: ReactNode }): JSX.Element {
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
    return Effect.runSync(
      Scope.extend(
        BridgeTransport.make({
          bridges: [NavigationBridge, GatekeeperBridge] as const,
          layers: [navLayer, gatekeeperWebReceiverLayer] as const,
          side: 'Web',
        }).pipe(Effect.provide(Layer.succeed(TransportAdapter, replayAdapter))),
        scope
      )
    )
  })

  useEffect(() => {
    Effect.runFork(transport.signalReady)
    return (): void => {
      Effect.runFork(Scope.close(scope, Exit.void))
    }
  }, [transport, scope])

  return (
    <TransportContext.Provider value={transport}>
      <NavigationBridgeHandler sender={transport.sendMessage} />
      {children}
    </TransportContext.Provider>
  )
}

export { TransportProvider }
