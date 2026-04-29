import { useNavigation, useRouter } from 'expo-router'
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
import { useColorScheme } from '../hooks/use-color-scheme.ts'
import { Colors } from '../theme.ts'

interface EmbeddedWebViewHandle {
  postMessage(message: string): void
}

type EmbeddedWebViewSource = { uri: string } | { html: string; baseUrl?: string }

interface EmbeddedWebViewProps {
  readonly source: EmbeddedWebViewSource
  readonly injectedScript?: string
  readonly onMessage?: (event: WebViewMessageEvent) => void
}

type HostBridgeMessage =
  | { type: 'host:route'; canGoBack: boolean }
  | { type: 'host:ready' }
  | { type: 'host:navigate'; path: string }

const isHostBridgeMessage = (value: unknown): value is HostBridgeMessage => {
  if (typeof value !== 'object' || value === null) return false
  const type: unknown = Reflect.get(value, 'type')
  return type === 'host:route' || type === 'host:ready' || type === 'host:navigate'
}

/**
 * WebView wrapper that hosts a single bundle's source.html and integrates with
 * the host navigator. Top-level navigations away from the initial source are
 * intercepted and opened in the system browser (SFSafariViewController on iOS,
 * Custom Tabs on Android), so the embedded bundle stays mounted.
 *
 * The page may use the host-bridge protocol via `postMessage`:
 * - `host:route { canGoBack }` — drives the screen header's back chevron
 * - `host:ready` — dismisses the native loading overlay
 * - `host:navigate { path }` — asks the host to `router.push(path)`
 *
 * Two-way messaging: pass `onMessage` to receive non-`host:*` postMessage
 * calls from the page, and call `postMessage` on the imperative ref to push
 * messages back into the page.
 */
const EmbeddedWebView = forwardRef<EmbeddedWebViewHandle, EmbeddedWebViewProps>(
  function EmbeddedWebView({ source, injectedScript, onMessage }, ref): JSX.Element {
    const webviewRef = useRef<WebView>(null)
    const navigation = useNavigation()
    const router = useRouter()
    const colorScheme = useColorScheme()
    const palette = colorScheme === 'dark' ? Colors.dark : Colors.light
    const [canGoBack, setCanGoBack] = useState(false)
    const [isReady, setIsReady] = useState(false)
    const initialUrlRef = useRef<string | null>(null)

    useImperativeHandle(
      ref,
      () => ({
        postMessage(message) {
          webviewRef.current?.postMessage(message)
        },
      }),
      []
    )

    const handleMessage = useCallback(
      (event: WebViewMessageEvent): void => {
        const raw = event.nativeEvent.data
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          onMessage?.(event)
          return
        }
        if (isHostBridgeMessage(parsed)) {
          if (parsed.type === 'host:route') setCanGoBack(parsed.canGoBack)
          else if (parsed.type === 'host:ready') setIsReady(true)
          else if (parsed.type === 'host:navigate') router.push(parsed.path)
          return
        }
        onMessage?.(event)
      },
      [onMessage, router]
    )

    const renderHeaderLeft = useCallback(
      ({ tintColor }: { tintColor?: string }): JSX.Element => (
        <Pressable
          onPress={() => webviewRef.current?.postMessage(JSON.stringify({ type: 'host:back' }))}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Text style={[styles.backLabel, tintColor ? { color: tintColor } : null]}>‹ Back</Text>
        </Pressable>
      ),
      []
    )

    useEffect(() => {
      navigation.setOptions({ headerLeft: canGoBack ? renderHeaderLeft : undefined })
    }, [canGoBack, navigation, renderHeaderLeft])

    return (
      <View style={styles.container}>
        <WebView
          ref={webviewRef}
          source={source}
          injectedJavaScriptBeforeContentLoaded={injectedScript}
          onMessage={handleMessage}
          onLoadEnd={() => {
            setIsReady(true)
          }}
          onShouldStartLoadWithRequest={(request) => {
            // Allow the very first load (the bundle's source.html) and any
            // reload of that same URL. Anything else is an external page —
            // open it in the system browser so the user gets native chrome /
            // back gesture.
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
  backLabel: {
    fontSize: 17,
  },
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
