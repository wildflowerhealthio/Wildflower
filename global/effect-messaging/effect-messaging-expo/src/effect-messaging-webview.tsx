import { useNavigation } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import {
  forwardRef,
  type JSX,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * Imperative handle exposed via `ref`. The transport's bare sender holds
 * one of these to push encoded messages into the embedded page;
 * consumers generally don't call this directly — they go through
 * `transport.sendMessage(...)` on a transport built by
 * {@link makeExpoTransport}.
 */
interface EffectMessagingWebViewHandle {
  postMessage(message: string): void
}

/**
 * What the embedded WebView should load:
 * - `{ uri }` — load a remote URL or `file://` asset.
 * - `{ html, baseUrl? }` — inline HTML, with `baseUrl` controlling
 *   relative-path resolution.
 */
type EffectMessagingWebViewSource = { uri: string } | { html: string; baseUrl?: string }

interface EffectMessagingWebViewProps {
  /**
   * Page contents to load. The first navigation is treated as "internal";
   * subsequent navigations open in the system browser so the embedded
   * bundle stays mounted.
   */
  readonly source: EffectMessagingWebViewSource
  /**
   * JS injected before any page script runs. Used by the transport to
   * publish `window.__INITIAL_MESSAGES__`.
   */
  readonly injectedScript?: string
  /**
   * Receives every message the page posts via
   * `window.ReactNativeWebView.postMessage`. The transport wires this
   * to its dispatch fiber's enqueue.
   */
  readonly onMessage: (event: WebViewMessageEvent) => void
  /**
   * Element rendered on top of the WebView until its first `onLoadEnd`
   * fires. The consumer owns the palette and any overlay positioning —
   * this component just stops rendering it once the page is ready.
   */
  readonly loader?: JSX.Element
  /**
   * When `true`, render a `‹ Back` button in the screen header. The
   * consumer decides what `onBackPress` does (typically: send a
   * `HostBackRequested` message to the page). Omit (or leave
   * `false`) when the consumer doesn't expose page-driven back
   * navigation.
   */
  readonly canGoBack?: boolean
  /** Invoked when the user taps the header back button. Required when `canGoBack` is `true`. */
  readonly onBackPress?: () => void
}

/**
 * WebView wrapper that hosts a single bundle's page and integrates with
 * the host navigator. The component is a pure transport surface — it
 * holds the WebView ref, dismisses its loader overlay on `onLoadEnd`,
 * keeps the user inside the embedded bundle for navigations to its
 * source, and redirects external-link clicks to the system browser.
 *
 * No domain protocol lives here; the message vocabulary is owned by
 * `effect-messaging` and the slices that wire bridges. The
 * `canGoBack` / `onBackPress` pair
 * is the only cross-cut: it lets the consumer drive the screen
 * header's back chevron from a `RouteChanged` message without coupling
 * this component to the message schemas.
 */
const EffectMessagingWebView = forwardRef<
  EffectMessagingWebViewHandle,
  EffectMessagingWebViewProps
>(function EffectMessagingWebView(
  { source, injectedScript, onMessage, loader, canGoBack, onBackPress },
  ref
): JSX.Element {
  const webviewRef = useRef<WebView>(null)
  const navigation = useNavigation()
  const [isReady, setIsReady] = useState(false)
  const initialUrlRef = useRef<string | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      postMessage(message): void {
        webviewRef.current?.postMessage(message)
      },
    }),
    []
  )

  useEffect(() => {
    if (canGoBack !== true || onBackPress === undefined) {
      navigation.setOptions({ headerLeft: undefined })
      return
    }
    const handlePress = onBackPress
    const headerLeft = ({ tintColor }: { tintColor?: string }): JSX.Element => (
      <Pressable
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={12}
      >
        <Text style={[styles.backLabel, tintColor ? { color: tintColor } : null]}>‹ Back</Text>
      </Pressable>
    )
    navigation.setOptions({ headerLeft })
  }, [canGoBack, navigation, onBackPress])

  const onLoadEnd = useCallback(() => {
    setIsReady(true)
  }, [])

  return (
    <View style={styles.container}>
      <WebView
        ref={webviewRef}
        source={source}
        injectedJavaScriptBeforeContentLoaded={injectedScript}
        onMessage={onMessage}
        onLoadEnd={onLoadEnd}
        onShouldStartLoadWithRequest={(request) => {
          // Allow the very first load (the bundle's source) and any reload
          // of that same URL. Anything else is an external page — open it
          // in the system browser so the user gets native chrome and back
          // gesture without tearing the embedded bundle down.
          if (initialUrlRef.current === null) {
            initialUrlRef.current = request.url
            return true
          }
          if (request.url === initialUrlRef.current) return true
          void WebBrowser.openBrowserAsync(request.url)
          return false
        }}
        style={styles.webview}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
      />
      {!isReady && loader}
    </View>
  )
})

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
  backLabel: { fontSize: 17 },
})

export { EffectMessagingWebView }
export type {
  EffectMessagingWebViewHandle,
  EffectMessagingWebViewProps,
  EffectMessagingWebViewSource,
}
