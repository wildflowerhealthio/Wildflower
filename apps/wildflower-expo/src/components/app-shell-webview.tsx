import AppsBridge from 'apps-core/bridge'
import { AppsBridgeExpo } from 'apps-expo'
import { CollectorBridgeExpo } from 'collector-expo'
import CollectorBridge from 'collector-fundamentals/bridge'
import { Effect, Layer } from 'effect'
import { BareSender, type BareSenderService } from 'effect-messaging-core'
import { EffectMessagingWebView, WithTransport, type ExpoTransport } from 'effect-messaging-expo'
import { Loader } from 'expo-tundraish'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { GatekeeperBridgeExpo } from 'gatekeeper-expo'
import { NavigationBridge } from 'navigation-core'
import { NavigationBridgeExpo } from 'navigation-expo'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type JSX,
} from 'react'
import { TunnelStore } from 'tunnel-core/livestore'
import { html } from 'wildflower-react/embeddable-html'
import { useWildflowerStore } from '../livestore/livestore-store.ts'

type Bridges = readonly [
  typeof NavigationBridge,
  typeof GatekeeperBridge,
  typeof CollectorBridge,
  typeof AppsBridge,
]

/**
 * Imperative handle exposed via `ref`. Hosts forward sniffer events
 * from the modal `<CollectorModalScreen>` back through `CollectorBridge`
 * so the embedded SPA's sync runner can parse them.
 *
 * `sendMessage` is the typed multi-bridge sender — encodes via each
 * bridge's outbound schemas. `postRawMessage` is the *bypass* path:
 * it accepts an already-encoded bridge wire string and injects it
 * directly into the WebView. Use the raw path when a paired transport
 * (today: the modal's `<BrowserSnifferWebView>` forwarding sniffer
 * events through `CollectorBridge.Host`) speaks the same wire format
 * and the host is acting as a router — the round trip through
 * `decode → typed handler → encode` is a no-op the raw path skips.
 */
interface AppShellWebViewHandle {
  readonly sendMessage: ExpoTransport<Bridges>['sendMessage']
  readonly postRawMessage: (rawWire: string) => void
}

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
   * Optional pre-decode hook fired with the raw wire string for every
   * inbound bridge message *in addition to* the typed dispatch. Wire
   * this when an outer transport speaks the same wire format and
   * you want to forward verbatim without a decode + re-encode round
   * trip (`Click` / `CancelSnifferRequest`).
   */
  readonly onRawMessage?: (rawWire: string) => void
}

const AppShellWebView = forwardRef<AppShellWebViewHandle, AppShellWebViewProps>(
  function AppShellWebView(
    { route, baseUrl, onRouteChanged, token, onRawMessage, ...props }: AppShellWebViewProps,
    ref
  ): JSX.Element {
    const webviewBareSenderRef = useRef<BareSenderService>(null)
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
      [store]
    )

    // Bearer tokens are deliberately NOT in `initialMessages` —
    // `effect-messaging-expo`'s `useTransport` encodes initial messages
    // into the WebView's URL as query params, which would leak the
    // token into native WebView logs and Sentry breadcrumbs. Issue
    // `AuthTokenIssued` through `transport.sendMessage` in
    // `<InnerAppShellWebView>` below instead; the bridge layer queues
    // it until the WebView connects.
    const initialMessages = [{ _tag: 'HostRequestedWebNavigation' as const, path: route }] as const

    return (
      <WithTransport<Bridges>
        initialMessages={initialMessages}
        bridges={[NavigationBridge, GatekeeperBridge, CollectorBridge, AppsBridge] as const}
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
          <InnerAppShellWebView
            ref={ref}
            transport={transport}
            webviewBareSenderRef={webviewBareSenderRef}
            token={token}
            onRawMessage={onRawMessage}
            {...props}
          />
        )}
      </WithTransport>
    )
  }
)

/**
 * The single persistent WebView that hosts the wildflower-react SPA.
 * Owns the `ExpoTransport` lifecycle (Navigation + Gatekeeper +
 * Collector + Apps bridges, layers, initial messages, scope).
 *
 * The native tab bar lives **above** this component and drives
 * navigation via `sendMessage({ _tag: 'HostRequestedWebNavigation' })`;
 * the WebView stays mounted across tab switches. The current path is
 * surfaced through `onRouteChanged` so the tab bar can highlight the
 * active tab.
 */
const InnerAppShellWebView = forwardRef<
  AppShellWebViewHandle,
  {
    transport: ExpoTransport<Bridges>
    token: AppShellWebViewProps['token']
    onRawMessage: AppShellWebViewProps['onRawMessage']
    webviewBareSenderRef: React.RefObject<BareSenderService | null>
  }
>(function InnerAppShellWebView(
  { transport, token, onRawMessage, webviewBareSenderRef },
  ref
): JSX.Element {
  // Dispatch the bearer token as soon as the transport is constructed
  // — the bridge layer queues outbound messages until the WebView
  // side connects, so we don't need to wait for a "ready" signal.
  // Kept out of `initialMessages` so the token never appears in the
  // WebView's URL query string.
  useEffect(() => {
    if (token === undefined) return
    Effect.runFork(transport.sendMessage({ _tag: 'AuthTokenIssued', token }))
  }, [transport, token])

  useImperativeHandle<AppShellWebViewHandle, AppShellWebViewHandle>(
    ref,
    () => ({
      sendMessage: transport.sendMessage,
      postRawMessage: (rawWire: string): void => {
        // Skips the typed sender's encode step. Pre-mount sends are
        // dropped here (no buffering) — the typed path provides a
        // queued sender for the typed shape; the raw path is for
        // mid-session router forwarding where buffering would just
        // muddle ordering against in-flight typed sends.
        const sender = webviewBareSenderRef.current
        if (sender !== null) Effect.runFork(sender.bareSender(rawWire))
      },
    }),
    [transport, webviewBareSenderRef]
  )

  // Splice `onRawMessage` in front of the typed `onMessage` so a
  // consumer wiring raw passthrough sees every payload before the
  // bridge's typed dispatch processes it. Both paths run for every
  // message; consumers typically pair a raw forwarder for some tags
  // with no-op typed handlers for those same tags.
  const handleMessage = useCallback(
    (event: Parameters<typeof transport.onMessage>[0]) => {
      if (onRawMessage !== undefined) onRawMessage(event.nativeEvent.data)
      return transport.onMessage(event)
    },
    [transport, onRawMessage]
  )

  return (
    <EffectMessagingWebView
      ref={webviewBareSenderRef}
      source={{ html, baseUrl: transport.embedUrl }}
      onMessage={handleMessage}
      loader={<Loader />}
    />
  )
})

export { AppShellWebView }
export type { AppShellWebViewHandle, AppShellWebViewProps, Bridges }
