import { Effect, Exit, Scope } from 'effect'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { NavigationBridge } from 'interop-core'
import { EmbeddedWebView, type ExpoTransport, makeExpoTransport } from 'interop-expo'
import { type JSX, useEffect, useState } from 'react'
import { html } from 'wildflower-react/embeddable-html'

interface GatekeeperWebViewProps {
  readonly baseUrl: string
  readonly route: string
  readonly token?: string
}

type Bridges = readonly [typeof NavigationBridge, typeof GatekeeperBridge]

/**
 * Embedded gatekeeper SPA wrapped for the Expo host. Composes
 * {@link NavigationBridge} (initial route, host-driven nav, route
 * tracking, native back) with {@link GatekeeperBridge} (bearer token
 * delivery) and threads them through {@link makeExpoTransport}.
 *
 * The transport is constructed inside `useEffect` rather than at module
 * load: it owns a `Scope` whose finalizers (dispatch fiber interrupt,
 * queue shutdown) must run on unmount. The two-phase `useState +
 * useEffect` lets the component render once with a placeholder while
 * the scoped Effect resolves, then re-render with the live transport's
 * `injectedScript` / `onMessage` props once it's ready.
 *
 * Per-prop `useEffect` deps trigger a tear-down + rebuild when `route`
 * or `token` change — initial messages bake into `injectedScript` at
 * construction, so re-running the effect with new opts is the only way
 * to seed a different initial route or token.
 */
function GatekeeperWebView({ baseUrl, route, token }: GatekeeperWebViewProps): JSX.Element {
  const [transport, setTransport] = useState<ExpoTransport<Bridges> | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)

  useEffect(() => {
    // Build initial messages from the props. Each entry is a typed
    // value; the transport encodes them into `__INITIAL_MESSAGES__`.
    const initialMessages = [
      {
        _tag: 'NativeRequestedWebNavigation' as const,
        path: route,
      },
      ...(token === undefined ? [] : [{ _tag: 'AuthTokenIssued' as const, token }]),
    ]

    const navigationLayer = NavigationBridge.Native.ReceiverLayer({
      // The web side reports route changes; the host updates its back
      // chevron state from each one.
      RouteChanged: ({ canGoBack: cgb }) => Effect.sync(() => setCanGoBack(cgb)),
    })

    // Gatekeeper has no Web→Native messages today, so its Native
    // ReceiverLayer accepts an empty handlers record.
    const gatekeeperLayer = GatekeeperBridge.Native.ReceiverLayer({})

    // Manual Scope management: build a scope, run the construction
    // Effect against it, store the resolved transport in state. Cleanup
    // closes the scope, which interrupts the dispatch fiber and shuts
    // down the queue.
    const scope = Effect.runSync(Scope.make())
    const program = makeExpoTransport({
      bridges: [NavigationBridge, GatekeeperBridge] as const,
      layers: [navigationLayer, gatekeeperLayer] as const,
      initialMessages,
    })
    const built = Effect.runSync(Scope.extend(program, scope))
    setTransport(built)

    return (): void => {
      Effect.runSync(Scope.close(scope, Exit.void))
      setTransport(null)
    }
  }, [route, token])

  const onBackPress = (): void => {
    if (transport === null) return
    Effect.runSync(transport.sendMessage({ _tag: 'NativeBackRequested' }))
  }

  // Render the WebView once the transport is ready. The brief
  // pre-resolution render is a no-op shell — the scoped Effect is sync,
  // so the second render lands within the same React tick.
  if (transport === null) return <></>

  return (
    <EmbeddedWebView
      ref={transport.webviewHandleRef}
      source={{ html, baseUrl }}
      injectedScript={transport.injectedScript}
      onMessage={transport.onMessage}
      canGoBack={canGoBack}
      onBackPress={onBackPress}
    />
  )
}

export { GatekeeperWebView }
export type { GatekeeperWebViewProps }
