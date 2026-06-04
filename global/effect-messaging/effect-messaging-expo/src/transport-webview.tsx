import { Effect } from 'effect'
import type { BareSenderFunction } from 'effect-messaging-core'
import * as WebBrowser from 'expo-web-browser'
import { forwardRef, type JSX, useImperativeHandle, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * What the embedded WebView should load. Either a URI or inline HTML
 * with an optional `baseUrl` for relative-path resolution.
 */
type TransportWebViewSource = { uri: string } | { html: string; baseUrl?: string }

interface TransportWebViewProps {
  /** Page contents to load. */
  readonly source: TransportWebViewSource
  /** Receives every message the page posts via `window.ReactNativeWebView.postMessage`. */
  readonly onMessage: (event: WebViewMessageEvent) => void
  /**
   * Opt-in routing predicate. Return `true` to open the URL in the
   * system browser; return `false` (or omit the predicate entirely) to
   * keep the navigation in-WebView.
   *
   * @remarks
   * **Default is "always in-WebView."** This component does not enforce
   * a same-origin policy on its own — every navigation stays in the
   * WebView unless the caller opts in to a per-URL routing decision.
   * Supply this prop when the host wants cross-origin or
   * out-of-bundle URLs to escape to the system browser (e.g. a "Help"
   * link the SPA shouldn't try to render). `about:blank` and `data:`
   * bootstrap URIs are always allowed in-WebView regardless of this
   * predicate.
   */
  readonly shouldOpenInSystemBrowser?: (url: string) => boolean
  /**
   * Script injected into the WebView before the page's own scripts
   * execute. Forwarded verbatim to react-native-webview's
   * `injectedJavaScriptBeforeContentLoaded`. Use when the host needs
   * to install a shim or instrumentation that must run before any
   * page-level code (e.g. the browser-sniffer's fetch/XHR wrappers).
   */
  readonly injectedJavaScriptBeforeContentLoaded?: string
}

/**
 * WebView wrapper that hosts a single bundle's page. Pure transport
 * surface — holds the WebView ref and keeps every navigation
 * in-WebView by default.
 *
 * @remarks
 * Callers that want cross-origin or out-of-bundle URLs to escape to
 * the system browser supply `shouldOpenInSystemBrowser` (return `true`
 * for the URLs they want routed out). Pre-content shims (e.g.
 * fetch/XHR wrappers) install via
 * `injectedJavaScriptBeforeContentLoaded`.
 */
const TransportWebView = forwardRef<BareSenderFunction, TransportWebViewProps>(
  function TransportWebView(
    { source, onMessage, shouldOpenInSystemBrowser, injectedJavaScriptBeforeContentLoaded },
    bareSenderServiceRef
  ): JSX.Element {
    const webviewRef = useRef<WebView>(null)

    useImperativeHandle(
      bareSenderServiceRef,
      (): BareSenderFunction =>
        (message: string): Effect.Effect<void> => {
          return Effect.logDebug('TransportWebView: postMessage', { message }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                webviewRef.current?.postMessage(message)
              })
            )
          )
        },
      []
    )

    return (
      <View style={styles.container}>
        <WebView
          ref={webviewRef}
          source={source}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(request) => {
            // `about:blank` and `data:` URIs are bootstrap navigations
            // the WebView fires while rendering inline HTML — always
            // allow them or the page never loads.
            if (request.url === 'about:blank' || request.url.startsWith('data:')) return true
            if (shouldOpenInSystemBrowser?.(request.url) !== true) return true
            Effect.runFork(
              Effect.tryPromise({
                try: () => WebBrowser.openBrowserAsync(request.url),
                catch: (e) => e,
              }).pipe(Effect.catchAllCause(Effect.logError))
            )
            return false
          }}
          injectedJavaScriptBeforeContentLoaded={injectedJavaScriptBeforeContentLoaded}
          style={styles.webview}
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
        />
      </View>
    )
  }
)

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
})

export { TransportWebView }
export type { TransportWebViewProps, TransportWebViewSource }
