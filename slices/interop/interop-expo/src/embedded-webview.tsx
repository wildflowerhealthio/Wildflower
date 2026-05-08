import { useNavigation } from 'expo-router'
import { Colors, useColorScheme } from 'expo-tundraish'
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
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * Imperative handle exposed via `ref`. The interop message handler holds
 * one of these to push encoded messages into the embedded page; consumers
 * generally don't call this directly — they go through
 * {@link MessageHandler.sendMessage} on a handler from
 * {@link makeExpoMessageHandler} or {@link useMessageHandler}.
 */
interface EmbeddedWebViewHandle {
  postMessage(message: string): void
}

/**
 * What the embedded WebView should load:
 * - `{ uri }` — load a remote URL or `file://` asset.
 * - `{ html, baseUrl? }` — inline HTML, with `baseUrl` controlling
 *   relative-path resolution.
 */
type EmbeddedWebViewSource = { uri: string } | { html: string; baseUrl?: string }

interface EmbeddedWebViewProps {
  /**
   * Page contents to load. The first navigation is treated as "internal";
   * subsequent navigations open in the system browser so the embedded
   * bundle stays mounted.
   */
  readonly source: EmbeddedWebViewSource
  /**
   * JS injected before any page script runs. Used by the interop
   * message handler to publish `window.__INITIAL_MESSAGES__`.
   */
  readonly injectedScript?: string
  /**
   * Receives every message the page posts via
   * `window.ReactNativeWebView.postMessage`. The interop hook wires this
   * to its dispatcher.
   */
  readonly onMessage: (event: WebViewMessageEvent) => void
  /**
   * When `true`, render a `‹ Back` button in the screen header. The
   * consumer decides what `onBackPress` does (typically: send a
   * `NativeBackRequested` message to the page). Omit (or leave
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
 * the interop and slice cores. The `canGoBack` / `onBackPress` pair
 * is the only cross-cut: it lets the consumer drive the screen
 * header's back chevron from a `RouteChanged` message without coupling
 * this component to the message schemas.
 */
const EmbeddedWebView = forwardRef<EmbeddedWebViewHandle, EmbeddedWebViewProps>(
  function EmbeddedWebView(
    { source, injectedScript, onMessage, canGoBack, onBackPress },
    ref
  ): JSX.Element {
    const webviewRef = useRef<WebView>(null)
    const navigation = useNavigation()
    const colorScheme = useColorScheme()
    const palette = colorScheme === 'dark' ? Colors.dark : Colors.light
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
        {!isReady && (
          <View
            style={[styles.loaderOverlay, { backgroundColor: palette.background }]}
            pointerEvents="none"
          >
            <ActivityIndicator size="large" color={palette.icon} />
          </View>
        )}
      </View>
    )
  }
)

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
  backLabel: { fontSize: 17 },
  loaderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
})

export { EmbeddedWebView }
export type { EmbeddedWebViewHandle, EmbeddedWebViewProps, EmbeddedWebViewSource }
