import AppsBridge from 'apps-core/bridge'
import { AppsBridgeExpo } from 'apps-expo'
import CollectorBridge from 'collector-fundamentals/bridge'
import type { WebViewSource } from 'collector-fundamentals/model'
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
 * from the modal `<RunSyncModalScreen>` back through `CollectorBridge`
 * so the embedded SPA's sync runner can parse them, and emit the
 * `TunnelStarted` / `TunnelFailed` AppsBridge replies the SPA's
 * `useRequestTunnel` is awaiting.
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
   * Fires when the SPA asks the host to open a sniffer-enabled WebView
   * ("Import Now"). The host pushes a `<RunSyncModalScreen>` and
   * forwards sniffer events back via the imperative handle's
   * `postRawMessage`.
   */
  readonly onRequestSniffableWebView?: (source: WebViewSource.Any) => void
  /**
   * Fires when the SPA's `CollectorBridgeMessageHandler` decides an
   * in-flight sniffer request should stop. The host forwards the id
   * to the active `<BrowserSnifferWebView>`'s `cancelRequest(id)` ref.
   */
  readonly onCancelSnifferRequest?: (id: string) => void
  /** Fires when the SPA's sync runner declares the active sync done. */
  readonly onSniffingComplete?: () => void
  /**
   * Fires when the SPA's handler asks the host to mount a fresh page
   * in the active sniffer WebView (next scripted-navigation step).
   */
  readonly onOpen?: (source: WebViewSource.Any) => void
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
    {
      route,

      baseUrl,
      onRouteChanged,
      onRequestSniffableWebView,
      onCancelSnifferRequest,
      onSniffingComplete,
      onOpen,
      token,
      onRawMessage,
      ...props
    }: AppShellWebViewProps,
    ref
  ): JSX.Element {
    const webviewBareSenderRef = useRef<BareSenderService>(null)

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
            CollectorBridge.Host.ReceiverLayer({
              RequestSniffableWebView: ({ source }) =>
                Effect.gen(function* () {
                  // Defense-in-depth: the bridge's `WebViewSource` schema
                  // already pins `Uri` to `https://` only, so a malformed
                  // message would fail to decode at the transport boundary.
                  if (
                    source._tag === 'Uri' &&
                    !source.uri.startsWith('https://') &&
                    !source.uri.startsWith('http://')
                  ) {
                    yield* Effect.logWarning(
                      `AppShellWebView: refusing non-http(s) RequestSniffableWebView URI ${source.uri}`
                    )
                    return
                  }
                  onRequestSniffableWebView?.(source)
                }),
              CancelSnifferRequest: ({ id }) =>
                Effect.sync(() => {
                  onCancelSnifferRequest?.(id)
                }),
              SniffingComplete: () =>
                Effect.sync(() => {
                  onSniffingComplete?.()
                }),
              Open: ({ source }) =>
                Effect.sync(() => {
                  onOpen?.(source)
                }),
              // `Click` has no typed callback — the injected sniffer
              // handles `document.querySelector(...)?.click()` itself, so
              // the host's only job is to forward the wire to the sniffer
              // WebView. Consumers wire that via `onRawMessage`.
              Click: () => Effect.void,
            }),
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
