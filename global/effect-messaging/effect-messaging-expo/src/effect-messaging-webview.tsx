import { Effect } from 'effect'
import type { BareSenderService } from 'effect-messaging-core'
import * as WebBrowser from 'expo-web-browser'
import { forwardRef, type JSX, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * What the embedded WebView should load. Either a URI or inline HTML
 * with an optional `baseUrl` for relative-path resolution.
 */
type EffectMessagingWebViewSource = { uri: string } | { html: string; baseUrl?: string }

interface EffectMessagingWebViewProps {
  /**
   * Page contents to load. The first navigation is treated as
   * "internal"; subsequent navigations open in the system browser
   * so the embedded bundle stays mounted.
   */
  readonly source: EffectMessagingWebViewSource
  /** Receives every message the page posts via `window.ReactNativeWebView.postMessage`. */
  readonly onMessage: (event: WebViewMessageEvent) => void
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
}

/**
 * WebView wrapper that hosts a single bundle's page. Pure transport
 * surface — holds the WebView ref, dismisses its loader overlay on
 * `onLoadEnd`, keeps the user inside the embedded bundle for
 * navigations to its source, and redirects external-link clicks to
 * the system browser.
 */
const EffectMessagingWebView = forwardRef<BareSenderService, EffectMessagingWebViewProps>(
  function EffectMessagingWebView({ source, onMessage, loader }, ref): JSX.Element {
    const webviewRef = useRef<WebView>(null)
    const [isReady, setIsReady] = useState(false)
    const initialUrlRef = useRef<string | null>(null)

    useImperativeHandle(
      ref,
      () => ({
        bareSender(message): Effect.Effect<void> {
          return Effect.sync(() => {
            Effect.log('EffectMessagingWebView: postMessage', { message })
            webviewRef.current?.postMessage(message)
          })
        },
      }),
      []
    )

    const onLoadEnd = useCallback(() => {
      console.log('EffectMessagingWebView: onLoadEnd')
      setIsReady(true)
    }, [])

    return (
      <View style={styles.container}>
        <WebView
          ref={webviewRef}
          source={source}
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
  }
)

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
})

export { EffectMessagingWebView }
export type { EffectMessagingWebViewProps, EffectMessagingWebViewSource }
