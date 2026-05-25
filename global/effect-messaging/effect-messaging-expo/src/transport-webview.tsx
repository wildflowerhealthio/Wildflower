import { Effect, Match, Predicate } from 'effect'
import type { BareSenderService } from 'effect-messaging-core'
import * as WebBrowser from 'expo-web-browser'
import {
  forwardRef,
  type JSX,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * What the embedded WebView should load. Either a URI or inline HTML
 * with an optional `baseUrl` for relative-path resolution.
 */
type TransportWebViewSource = { uri: string } | { html: string; baseUrl?: string }

interface TransportWebViewProps {
  /**
   * Page contents to load. Default routing keeps same-origin
   * navigations in the WebView and opens cross-origin links in the
   * system browser. The "expected origin" is derived from `source.uri`
   * (for remote pages) or `source.baseUrl` (for inline HTML); this
   * default is overridden when `shouldHandleInWebView` is supplied.
   */
  readonly source: TransportWebViewSource
  /** Receives every message the page posts via `window.ReactNativeWebView.postMessage`. */
  readonly onMessage: (event: WebViewMessageEvent) => void
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
  /**
   * Sole gate on navigation routing when supplied. Return `true` to
   * keep the URL in-WebView, `false` to open it in the system browser.
   * **Replaces** the default same-origin enforcement entirely — pass
   * `() => true` for "always in-WebView" (e.g. a sniffer hosting
   * third-party pages whose OAuth flows redirect cross-origin), pass
   * a per-URL predicate for finer control. When omitted, the default
   * gate keeps same-origin in-WebView and routes cross-origin to the
   * system browser. `about:blank` and `data:` bootstrap URIs are
   * always allowed regardless of this prop.
   */
  readonly shouldHandleInWebView?: (url: string) => boolean
  /**
   * Script injected into the WebView before the page's own scripts
   * execute. Forwarded verbatim to react-native-webview's
   * `injectedJavaScriptBeforeContentLoaded`. Use when the host needs
   * to install a shim or instrumentation that must run before any
   * page-level code (e.g. the browser-sniffer's fetch/XHR wrappers).
   */
  readonly injectedJavaScriptBeforeContentLoaded?: string
}

const tryExtractOrigin = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * WebView wrapper that hosts a single bundle's page. Pure transport
 * surface — holds the WebView ref, dismisses its loader overlay on
 * `onLoadEnd`, and routes navigations (same-origin in-WebView,
 * cross-origin to the system browser by default).
 *
 * @remarks
 * Routing is overridable: pass `shouldHandleInWebView` to replace the
 * default same-origin gate with a per-URL predicate (e.g. `() => true`
 * for sniffer-style hosts that want every navigation in-WebView).
 * Pre-content shims (e.g. fetch/XHR wrappers) install via
 * `injectedJavaScriptBeforeContentLoaded`.
 */
const TransportWebView = forwardRef<BareSenderService, TransportWebViewProps>(
  function TransportWebView(
    { source, onMessage, loader, shouldHandleInWebView, injectedJavaScriptBeforeContentLoaded },
    bareSenderServiceRef
  ): JSX.Element {
    const webviewRef = useRef<WebView>(null)
    const [loadEnded, setLoadEnded] = useState(false)

    // Same-origin gate: derived from the configured source so a
    // `window.location.href = `${origin}/...`` from inside the SPA
    // stays in-WebView even when the URL differs from the boot URL
    // (e.g. extra path segments, dropped query params). When the
    // source has no resolvable origin (inline HTML with no baseUrl)
    // every non-bootstrap navigation goes to the system browser.
    const maybeExpectedOrigin = useMemo(
      () =>
        Match.value(source).pipe(
          Match.withReturnType<string | null>(),
          Match.when({ baseUrl: Predicate.isString }, ({ baseUrl }) => baseUrl),
          Match.when({ uri: Predicate.isString }, ({ uri }) => uri),
          Match.orElse(() => ''),
          tryExtractOrigin
        ),

      [source]
    )

    useImperativeHandle(
      bareSenderServiceRef,
      (): BareSenderService => ({
        bareSender(message): Effect.Effect<void> {
          return Effect.logDebug('TransportWebView: postMessage', { message }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                webviewRef.current?.postMessage(message)
              })
            )
          )
        },
      }),
      []
    )

    const handleLoadEnd = useCallback(() => {
      setLoadEnded(true)
    }, [])

    return (
      <View style={styles.container}>
        <WebView
          ref={webviewRef}
          source={source}
          onMessage={onMessage}
          onLoadEnd={handleLoadEnd}
          onShouldStartLoadWithRequest={(request) => {
            // `about:blank` and `data:` URIs are bootstrap navigations
            // the WebView fires while rendering inline HTML — always
            // allow them or the page never loads.
            if (request.url === 'about:blank' || request.url.startsWith('data:')) return true
            // When a `shouldHandleInWebView` predicate is supplied, the
            // caller fully owns routing — the default same-origin gate
            // is skipped. Otherwise, the default keeps same-origin
            // in-WebView and routes cross-origin to the system browser.
            const inWebView =
              shouldHandleInWebView !== undefined
                ? shouldHandleInWebView(request.url)
                : tryExtractOrigin(request.url) === maybeExpectedOrigin
            if (inWebView) return true
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
        {!loadEnded && loader}
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
