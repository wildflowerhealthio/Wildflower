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
   * Page contents to load. Same-origin navigations are kept inside the
   * embedded bundle; cross-origin ones open in the system browser.
   * The "expected origin" is derived from `source.uri` (for remote
   * pages) or `source.baseUrl` (for inline HTML).
   */
  readonly source: TransportWebViewSource
  /** Receives every message the page posts via `window.ReactNativeWebView.postMessage`. */
  readonly onMessage: (event: WebViewMessageEvent) => void
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
  /**
   * Additional gate applied AFTER the same-origin check. Return `false`
   * to force a same-origin URL to the system browser instead of keeping
   * it in-WebView. Defaults to `() => true` (every same-origin
   * navigation stays in-WebView). Use this hook to carve out
   * app-specific exceptions (e.g. a sub-path that should always open
   * externally) without polluting this generic transport with
   * project-specific routing knowledge.
   */
  readonly shouldHandleInWebView?: (url: string) => boolean
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
 * `onLoadEnd`, keeps the user inside the embedded bundle for
 * same-origin navigations, and redirects cross-origin link clicks to
 * the system browser.
 *
 * @remarks
 * Callers can pass `shouldHandleInWebView` to gate same-origin
 * navigations with app-specific exceptions — useful for forcing a
 * particular sub-path to open in the system browser without baking
 * project-specific routing into this generic transport.
 */
const TransportWebView = forwardRef<BareSenderService, TransportWebViewProps>(
  function TransportWebView(
    { source, onMessage, loader, shouldHandleInWebView },
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
            const requestOrigin = tryExtractOrigin(request.url)
            if (
              requestOrigin !== null &&
              requestOrigin === maybeExpectedOrigin &&
              (shouldHandleInWebView?.(request.url) ?? true)
            )
              return true
            Effect.runFork(
              Effect.tryPromise({
                try: () => WebBrowser.openBrowserAsync(request.url),
                catch: (e) => e,
              }).pipe(Effect.catchAllCause(Effect.logError))
            )
            return false
          }}
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
