import { AppsBridgeExpo } from 'apps-expo'
import { CollectorBridgeExpo } from 'collector-expo'
import { Effect, Layer } from 'effect'
import { BareSender, type BareSenderService } from 'effect-messaging-core'
import { EffectMessagingWebView, WithTransport, type ExpoTransport } from 'effect-messaging-expo'
import { HostMessagingProvider } from 'effect-messaging-react'
import { Loader } from 'expo-tundraish'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { useGatekeeperHostMessaging } from 'gatekeeper-react'
import { NavigationBridgeExpo } from 'navigation-expo'
import { useEffect, useMemo, useRef, type JSX, type ReactNode, type RefObject } from 'react'
import { TunnelStore } from 'tunnel-core/livestore'
import { html } from 'wildflower-react/embeddable-html'
import { useWildflowerStore } from '../livestore/livestore-store.ts'
import { bridges, type Bridges } from './app-shell-bridges.ts'

interface AppShellWebViewProps {
  readonly baseUrl: string
  /** Initial in-SPA route, e.g. `/apps`. */
  readonly route: string
  /** Bearer token issued to the embedded SPA on boot. */
  readonly token?: string
  /**
   * Fires every time the SPA emits `RouteChanged`. Hosts use this to
   * drive native-tab active state and the back-affordance.
   */
  readonly onRouteChanged?: (event: { pathname: string; canGoBack: boolean }) => void
  /**
   * Subtree rendered as siblings of the WebView and inside the
   * `<HostMessagingProvider>` this component mounts. Use for any
   * controls (tab bar, overlays) that need to call slice messaging
   * hooks like `useNavigationHostMessaging`.
   */
  readonly children?: ReactNode
}

/**
 * The persistent shell that hosts the wildflower-react SPA. Owns the
 * `ExpoTransport` lifecycle (Navigation + Gatekeeper + Collector +
 * Apps bridges, layers, initial messages, scope) and wraps its WebView
 * and `children` in a `<HostMessagingProvider>` so descendants can call
 * slice messaging hooks (`useNavigationHostMessaging`, etc.).
 *
 * Visually renders the WebView followed by `children`; a parent
 * supplies the surrounding layout (e.g. native tab bar below).
 *
 * The native tab bar lives **inside** this component's `children`,
 * inside the provider, so its press handlers can dispatch typed
 * navigation messages via `useNavigationHostMessaging`. The WebView
 * stays mounted across tab switches.
 */
const AppShellWebView = ({
  route,
  baseUrl,
  token,
  onRouteChanged,
  children,
}: AppShellWebViewProps): JSX.Element => {
  const webviewBareSenderRef = useRef<BareSenderService | null>(null)

  const collectorBridgeReceiverLayer = CollectorBridgeExpo.useReceiverLayer()

  // `AppsBridgeExpo.ReceiverLayer` requires `TunnelStore` (provided
  // from the wildflower-expo livestore) and `BareSender` (delegates
  // to the WebView's ref-exposed bare sender — the dispatcher pulls
  // it at handler-fire time, by which point the WebView is mounted).
  const store = useWildflowerStore()
  const appsBridgeReceiverLayer = useMemo(
    () =>
      AppsBridgeExpo.ReceiverLayer().pipe(
        Layer.provide(
          Layer.merge(
            TunnelStore.layerFrom(store),
            Layer.succeed(BareSender, {
              bareSender: (msg) => {
                if (webviewBareSenderRef.current === null) {
                  return Effect.dieMessage(
                    'AppShellWebView: BareSender invoked before the WebView mounted'
                  )
                }
                return webviewBareSenderRef.current.bareSender(msg)
              },
            })
          )
        )
      ),
    [store, webviewBareSenderRef]
  )

  // Bearer tokens are deliberately NOT in `initialMessages` —
  // `effect-messaging-expo`'s `useTransport` encodes initial messages
  // into the WebView's URL as query params, which would leak the
  // token into native WebView logs and Sentry breadcrumbs. Issue
  // `AuthTokenIssued` through the gatekeeper host-messaging hook
  // inside the provider's subtree instead; the bridge layer queues it
  // until the WebView connects.
  const initialMessages = [{ _tag: 'HostRequestedWebNavigation' as const, path: route }] as const

  return (
    <WithTransport<Bridges>
      initialMessages={initialMessages}
      bridges={bridges}
      layers={
        [
          NavigationBridgeExpo.ReceiverLayer(onRouteChanged),
          GatekeeperBridgeExpo.ReceiverLayer(),
          collectorBridgeReceiverLayer,
          appsBridgeReceiverLayer,
        ] as const
      }
      baseUrl={baseUrl}
      webviewHandleRef={webviewBareSenderRef}
    >
      {(transport) => (
        <HostMessagingProvider bridges={bridges} sendMessage={transport.sendMessage}>
          <InnerAppShellWebView
            transport={transport}
            webviewBareSenderRef={webviewBareSenderRef}
            token={token}
          />
          {children}
        </HostMessagingProvider>
      )}
    </WithTransport>
  )
}

interface InnerAppShellWebViewProps {
  readonly transport: ExpoTransport<Bridges>
  readonly token: AppShellWebViewProps['token']
  readonly webviewBareSenderRef: RefObject<BareSenderService | null>
}

const InnerAppShellWebView = ({
  transport,
  token,
  webviewBareSenderRef,
}: InnerAppShellWebViewProps): JSX.Element => {
  const { send: sendGatekeeper } = useGatekeeperHostMessaging()

  // Dispatch the bearer token as soon as the transport is constructed
  // — the bridge layer queues outbound messages until the WebView
  // side connects, so we don't need to wait for a "ready" signal.
  // Kept out of `initialMessages` so the token never appears in the
  // WebView's URL query string.
  useEffect(() => {
    if (token === undefined) return
    sendGatekeeper({ _tag: 'AuthTokenIssued', token })
  }, [sendGatekeeper, token])

  return (
    <EffectMessagingWebView
      ref={webviewBareSenderRef}
      source={{ html, baseUrl: transport.embedUrl }}
      onMessage={transport.onMessage}
      loader={<Loader />}
    />
  )
}

export { AppShellWebView }
export type { AppShellWebViewProps, Bridges }
