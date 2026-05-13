import CollectorBridge from 'collector-fundamentals/bridge'
import type { Link, WebViewSource } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import {
  EffectMessagingWebView,
  useTransport,
  type EffectMessagingWebViewHandle,
  type ExpoTransport,
} from 'effect-messaging-expo'
import { useNavigation } from 'expo-router'
import { Colors, useColorScheme } from 'expo-tundraish'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { NavigationBridge } from 'navigation-core'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type JSX,
} from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { html } from 'wildflower-react/embeddable-html'

type Bridges = readonly [typeof NavigationBridge, typeof GatekeeperBridge, typeof CollectorBridge]

/**
 * Imperative handle exposed via `ref`. Lets the host forward sniffer
 * events from a sibling `<BrowserSnifferWebView>` back through
 * CollectorBridge so the embedded SPA's sync runner can parse them.
 */
interface CollectorWebViewHandle {
  readonly sendCollectorMessage: ExpoTransport<Bridges>['sendMessage']
}

interface CollectorWebViewProps {
  readonly baseUrl: string
  /** Initial in-SPA route, e.g. `/collector`. */
  readonly route: string
  /** Bearer token issued to the embedded SPA on boot. */
  readonly token?: string
  /**
   * Fires when the SPA asks the host to open a sniffer-enabled WebView
   * ("Import Now"). The host pushes a `<RunSyncModalScreen>` (or
   * equivalent) and forwards sniffer events back via
   * `ref.current.sendCollectorMessage(...)`.
   */
  readonly onRequestSniffableWebView?: (source: WebViewSource.Any) => void
  /**
   * Fires when the SPA's `CollectorBridgeMessageHandler` decides an
   * in-flight sniffer request should stop (no entity matches the URL,
   * or a mid-stream decode fails). The host forwards the id to the
   * active `<BrowserSnifferWebView>`'s `cancelRequest(id)` ref.
   */
  readonly onCancelSnifferRequest?: (id: string) => void
  /** Fires when the SPA's sync runner declares the active sync done. */
  readonly onSniffingComplete?: () => void
  /**
   * Fires when the SPA's handler asks the host to mount a fresh page
   * in the active sniffer WebView (next step in the scripted
   * navigation). The host updates the BrowserSnifferWebView's source
   * to trigger the navigation; the sniffer's `injectedJavaScript`
   * re-runs and the page eventually fires `PageLoaded` back through
   * the bridge.
   */
  readonly onOpen?: (source: WebViewSource.Any) => void
  /**
   * Fires when the SPA's handler asks the host to synthesise a click
   * in the sniffed page. The host forwards through
   * `BrowserSnifferBridge.Host.sendMessage({ _tag: 'Click', querySelector })`,
   * which the injected sniffer runs as
   * `document.querySelector(querySelector)?.click()`.
   */
  readonly onClick?: (link: Link.Click) => void
}

/**
 * Embedded collector SPA wrapped for the Expo host. Owns the
 * `ExpoTransport` lifecycle (Navigation + Gatekeeper + Collector
 * bridges, layers, initial messages, scope) and the navigator chrome
 * (`headerLeft` for the `RouteChanged` back affordance). The host gets
 * the transport's `sendMessage` via `ref` so it can forward sniffer
 * events captured by a sibling `<BrowserSnifferWebView>` into this
 * bridge.
 */
const CollectorWebView = forwardRef<CollectorWebViewHandle, CollectorWebViewProps>(
  function CollectorWebView(
    {
      baseUrl,
      route,
      token,
      onRequestSniffableWebView,
      onCancelSnifferRequest,
      onSniffingComplete,
      onOpen,
      onClick,
    },
    ref
  ): JSX.Element {
    const navigation = useNavigation()
    const webviewHandleRef = useRef<EffectMessagingWebViewHandle>(null)

    const setHeaderLeft = useCallback(
      (renderer: undefined | ((props: { tintColor: string }) => JSX.Element)) => {
        navigation.setOptions({ headerLeft: renderer })
      },
      [navigation]
    )

    // Bearer tokens are deliberately NOT placed in `initialMessages` —
    // `effect-messaging-expo`'s `useTransport` encodes initial messages
    // into the WebView's URL as query params, which would leak the
    // token into native WebView logs and Sentry breadcrumbs. We issue
    // the `AuthTokenIssued` message through `transport.sendMessage`
    // below instead; the bridge layer queues it until the WebView
    // connects.
    const initialMessages = [{ _tag: 'HostRequestedWebNavigation' as const, path: route }]

    const transport: ExpoTransport<Bridges> = useTransport({
      initialMessages,
      bridges: [NavigationBridge, GatekeeperBridge, CollectorBridge] as const,
      layers: [
        NavigationBridge.Host.ReceiverLayer({
          RouteChanged: ({ canGoBack: cgb }) =>
            Effect.sync(() => {
              if (cgb) {
                setHeaderLeft(backButton)
              } else {
                setHeaderLeft(undefined)
              }
            }),
        }),
        GatekeeperBridge.Host.ReceiverLayer({}),
        CollectorBridge.Host.ReceiverLayer({
          RequestSniffableWebView: ({ source }) =>
            Effect.gen(function* () {
              // Defense-in-depth: the bridge's `WebViewSource` schema
              // already pins `Uri` to `https://` only, so a malformed
              // message would fail to decode at the transport boundary.
              // This check exists for the case where the schema is
              // loosened in the future — keep the host honest.
              if (source._tag === 'Uri' && !source.uri.startsWith('https://')) {
                yield* Effect.logWarning(
                  `CollectorWebView: refusing non-https RequestSniffableWebView URI ${source.uri}`
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
          Click: ({ querySelector }) =>
            Effect.sync(() => {
              onClick?.({ _tag: 'Click', querySelector })
            }),
        }),
      ] as const,
      baseUrl,
      webviewHandleRef,
    })

    // Dispatch the bearer token as soon as the transport is constructed
    // — the bridge layer queues outbound messages until the WebView
    // side connects, so we don't need to wait for a "ready" signal.
    // Kept out of `initialMessages` so the token never appears in the
    // WebView's URL query string.
    useEffect(() => {
      if (token === undefined) return
      Effect.runFork(transport.sendMessage({ _tag: 'AuthTokenIssued', token }))
    }, [transport, token])

    useImperativeHandle(
      ref,
      () => ({
        sendCollectorMessage: transport.sendMessage,
      }),
      [transport]
    )

    const onBackPress = useCallback((): void => {
      void Effect.runPromise(transport.sendMessage({ _tag: 'HostBackRequested' }))
    }, [transport])

    const backButton = useMemo(
      () =>
        ({ tintColor }: { tintColor?: string }): JSX.Element => (
          <Pressable
            onPress={onBackPress}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
          >
            <Text style={[styles.backLabel, tintColor === undefined ? null : { color: tintColor }]}>
              ‹ Back
            </Text>
          </Pressable>
        ),
      [onBackPress]
    )

    return (
      <EffectMessagingWebView
        ref={webviewHandleRef}
        source={{ html, baseUrl: transport.embedUrl }}
        onMessage={transport.onMessage}
        loader={<Loader />}
      />
    )
  }
)

const styles = StyleSheet.create({
  loaderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backLabel: { fontSize: 17 },
})

const Loader = (): JSX.Element => {
  const colorScheme = useColorScheme()
  const palette = colorScheme === 'dark' ? Colors.dark : Colors.light
  return (
    <View
      style={[styles.loaderOverlay, { backgroundColor: palette.background }]}
      pointerEvents="none"
    >
      <ActivityIndicator size="large" color={palette.icon} />
    </View>
  )
}

export { CollectorWebView }
export type { Bridges, CollectorWebViewHandle, CollectorWebViewProps }
