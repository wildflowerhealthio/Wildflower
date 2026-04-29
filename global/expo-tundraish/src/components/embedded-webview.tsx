import { Option } from 'effect'
import { useNavigation, useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import {
  forwardRef,
  type JSX,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { useColorScheme } from '../hooks/use-color-scheme.ts'
import { Colors } from '../theme.ts'
import {
  decodePageToHost,
  HostToPageMessage,
  PageToHostMessage,
  type HostToPageMessageType,
  type PageToHostMessageType,
} from './embedded-webview-protocol.ts'

/**
 * Imperative handle exposed to parents via `ref`. Use it to push messages back
 * into the embedded page (host → page direction). The page should listen on
 * `window.addEventListener('message', ...)` (iOS) or `document.addEventListener`
 * (Android) for the JSON-encoded payload.
 */
interface EmbeddedWebViewHandle {
  /** Send a JSON string to the embedded page. Caller is responsible for serialising. */
  postMessage(message: string): void
}

/**
 * What the embedded WebView should load:
 * - `{ uri }` — load a remote URL or `file://` asset.
 * - `{ html, baseUrl? }` — inline HTML, with `baseUrl` controlling relative-path resolution.
 */
type EmbeddedWebViewSource = { uri: string } | { html: string; baseUrl?: string }

interface EmbeddedWebViewProps {
  /** Page contents to load. The first navigation is treated as "internal"; subsequent navigations open in the system browser. */
  readonly source: EmbeddedWebViewSource
  /** JS injected before any page script runs — useful for declaring `host:overrideReady` early or polyfilling globals. */
  readonly injectedScript?: string
  /** Catch-all for non-bridge `postMessage` calls from the page. Bridge messages (`host:*`) are intercepted before this fires. */
  readonly onMessage?: (event: WebViewMessageEvent) => void
}

/**
 * `null` — no readiness signal received yet; `onLoadEnd` will auto-ready when the document finishes loading.
 * `false` — the page sent `host:overrideReady`, so auto-ready is suppressed and we wait for `host:ready`.
 * `true` — the page is ready; the loading overlay is dismissed.
 */
type ReadyState = boolean | null

/**
 * WebView wrapper that hosts a single bundle's page and integrates with the
 * host navigator. Top-level navigations away from the initial source are
 * intercepted and opened in the system browser (SFSafariViewController on iOS,
 * Custom Tabs on Android), so the embedded bundle stays mounted.
 *
 * See `PageToHostMessage` and `HostToPageMessage` for the bridge protocol.
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
    const [isReady, setIsReady] = useState<ReadyState>(null)
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

    const sendToPage = useCallback((message: HostToPageMessageType): void => {
      webviewRef.current?.postMessage(JSON.stringify(message))
    }, [])

    const dispatchPageMessage = useCallback(
      (message: PageToHostMessageType): void => {
        switch (message.type) {
          case 'host:route':
            setCanGoBack(message.canGoBack)
            return
          case 'host:ready':
            setIsReady(true)
            return
          case 'host:overrideReady':
            setIsReady((current) => (current === null ? false : current))
            return
          case 'host:navigate':
            router.push(message.path)
            return
        }
      },
      [router]
    )

    const handleMessage = useCallback(
      (event: WebViewMessageEvent): void => {
        const decoded = decodePageToHost(event.nativeEvent.data)
        if (Option.isNone(decoded)) {
          onMessage?.(event)
          return
        }
        dispatchPageMessage(decoded.value)
      },
      [dispatchPageMessage, onMessage]
    )

    

    useEffect(() => {
      if (!canGoBack) {
        navigation.setOptions({ headerLeft: undefined })
        return
      }

      const headerLeft = ({ tintColor }: { tintColor?: string }): JSX.Element => (
        <Pressable
          onPress={() => sendToPage({ type: 'host:back' })}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Text style={[styles.backLabel, tintColor ? { color: tintColor } : null]}>‹ Back</Text>
        </Pressable>
      )

      navigation.setOptions({ headerLeft })
    }, [canGoBack, navigation, sendToPage])

    const showLoader = useMemo(() => isReady !== true, [isReady])

    return (
      <View style={styles.container}>
        <WebView
          ref={webviewRef}
          source={source}
          injectedJavaScriptBeforeContentLoaded={injectedScript}
          onMessage={handleMessage}
          onLoadEnd={() => {
            // Default-ready for pages that don't use the bridge. Pages that
            // declared `host:overrideReady` already moved isReady to `false`,
            // and we don't override their decision here.
            setIsReady((current) => (current === null ? true : current))
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
        {showLoader && (
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

export { EmbeddedWebView, HostToPageMessage, PageToHostMessage }
export type { EmbeddedWebViewHandle, EmbeddedWebViewProps, EmbeddedWebViewSource }
