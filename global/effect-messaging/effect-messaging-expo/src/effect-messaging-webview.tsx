import * as WebBrowser from 'expo-web-browser'
import {
  forwardRef,
  type JSX,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * Imperative handle exposed via `ref`. The transport's bare sender
 * holds one of these to push encoded messages into the embedded page.
 */
interface EffectMessagingWebViewHandle {
  postMessage(message: string): void
}

/**
 * What the embedded WebView should load. Either a URI or inline HTML
 * with an optional `baseUrl` for relative-path resolution.
 */
type EffectMessagingWebViewSource = { uri: string } | { html: string; baseUrl?: string }

/**
 * Render function for a navigator-supplied `headerLeft`. The
 * navigator (e.g. expo-router) calls `setHeaderLeft(renderer)` on
 * mount; the consumer composes this with their navigator of choice.
 */
type SetHeaderLeft = (renderer: ((args: { tintColor?: string }) => ReactNode) | undefined) => void

interface EffectMessagingWebViewProps {
  /**
   * Page contents to load. The first navigation is treated as
   * "internal"; subsequent navigations open in the system browser
   * so the embedded bundle stays mounted.
   */
  readonly source: EffectMessagingWebViewSource
  /** JS injected before any page script runs. */
  readonly injectedScript?: string
  /** Receives every message the page posts via `window.ReactNativeWebView.postMessage`. */
  readonly onMessage: (event: WebViewMessageEvent) => void
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
  /**
   * Optional render-prop the consumer wires to its navigator's
   * `headerLeft`. The component never imports a navigator package —
   * this prop lets the consumer (e.g. a slice's expo wrapper) inject
   * a back chevron driven by a `RouteChanged` message without
   * coupling this generic component to any one router.
   */
  readonly setHeaderLeft?: SetHeaderLeft
  /**
   * Header-left renderer. When defined and `setHeaderLeft` is
   * present, the renderer is propagated to the navigator on mount
   * and updates; on unmount or when `undefined`, the navigator's
   * `headerLeft` is cleared.
   */
  readonly headerLeft?: (args: { tintColor?: string }) => ReactNode
}

/**
 * WebView wrapper that hosts a single bundle's page. Pure transport
 * surface — holds the WebView ref, dismisses its loader overlay on
 * `onLoadEnd`, keeps the user inside the embedded bundle for
 * navigations to its source, and redirects external-link clicks to
 * the system browser.
 *
 * @remarks
 * Generic and navigator-agnostic. The consumer supplies header
 * chrome (back chevron, etc.) through `setHeaderLeft` + `headerLeft`
 * and bridges it to expo-router / react-navigation / etc. on their
 * side.
 */
const EffectMessagingWebView = forwardRef<
  EffectMessagingWebViewHandle,
  EffectMessagingWebViewProps
>(function EffectMessagingWebView(
  { source, injectedScript, onMessage, loader, setHeaderLeft, headerLeft },
  ref
): JSX.Element {
  const webviewRef = useRef<WebView>(null)
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
    if (setHeaderLeft === undefined) return
    setHeaderLeft(headerLeft)
    return (): void => setHeaderLeft(undefined)
  }, [setHeaderLeft, headerLeft])

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
          // Allow the very first load (the bundle's source) and any
          // reload of that same URL. Anything else opens in the system
          // browser so the user gets native chrome and back gesture
          // without tearing the embedded bundle down.
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
})

export { EffectMessagingWebView }
export type {
  EffectMessagingWebViewHandle,
  EffectMessagingWebViewProps,
  EffectMessagingWebViewSource,
  SetHeaderLeft,
}
