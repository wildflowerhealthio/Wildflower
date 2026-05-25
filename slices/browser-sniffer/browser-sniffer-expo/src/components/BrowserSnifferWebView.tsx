import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { Effect, Exit, Layer, Scope } from 'effect'
import {
  BridgeTransport,
  type MessageHandler,
  TransportAdapter,
  type BareSenderFunction,
} from 'effect-messaging-core'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react'
import { StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'

/**
 * Imperative handle exposed via `ref`.
 *
 * `cancelRequest(id)` stops sniffer events for a specific in-flight
 * request — useful when the downstream parser decides the response is
 * irrelevant and wants to release the chunk-tracking state on the
 * page. The call goes over the same `BridgeTransport` the inbound
 * events use: the host sends `CancelSnifferRequest` as a typed
 * Host→Web bridge message, the injected sniffer's `message`-event
 * listener decodes it and removes the id from its active-request set.
 * The page then posts a `Cancelled` terminal event back so downstream
 * handlers can release per-id state.
 *
 * `click(querySelector)` dispatches a synthetic click on the sniffed
 * page. The host sends `Click` as a typed Host→Web bridge message,
 * the injected sniffer runs `document.querySelector(qs)?.click()`
 * inside the page (best-effort, no feedback on a missing element).
 */
interface BrowserSnifferWebViewHandle {
  cancelRequest(id: string): void
  click(querySelector: string): void
}

/** What the WebView should load. Mirrors `TransportWebViewSource`. */
type BrowserSnifferWebViewSource = { uri: string } | { html: string; baseUrl?: string }

type SnifferHandlers = MessageHandler.HandlersFor<typeof BrowserSnifferBridge.Host.InboundSchemas>

type TransportType = Effect.Effect.Success<
  ReturnType<typeof BridgeTransport.make<readonly [typeof BrowserSnifferBridge], 'Host'>>
>

interface BrowserSnifferWebViewProps {
  /** Page to sniff — either a remote URL or inline HTML. */
  readonly source: BrowserSnifferWebViewSource
  /**
   * Per-tag handlers invoked when the sniffer posts a typed message. Each
   * handler returns an `Effect<void>`; the dispatch fiber catches handler
   * defects, so a throw from one handler doesn't tear down the rest.
   */
  readonly handlers: SnifferHandlers
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
}

/**
 * For HTML sources, embed the sniffer script directly into the document
 * (right after `<head>`, or prepended when no `<head>` tag is present)
 * instead of relying solely on `injectedJavaScriptBeforeContentLoaded`.
 * RN-WebView's injection prop is unreliable on some Android builds and
 * on responses the WebView doesn't parse as HTML; embedding into the
 * document guarantees the script runs before any user `<script>` in
 * `<body>`, on every platform. Idempotent: if the prop ALSO fires, the
 * sniffer's `Symbol.for('browser-sniffer:state')` slot makes the second
 * install a no-op.
 *
 * For Uri sources we can't embed (the remote page is whatever it is),
 * so those still rely on the WebView's injection prop. That's the
 * original use case the prop was reliable for.
 */
const embedSnifferIntoHtml = (html: string): string => {
  const scriptTag = `<script>${snifferScript}</script>`
  // Insert right after `<head…>` so the sniffer runs before any other
  // `<script>` in `<head>` or `<body>`. Fall back to prepend (which may
  // trigger quirks mode if a doctype follows, but functional for our
  // injection purpose).
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch !== null) {
    const insertAt = headMatch.index + headMatch[0].length
    return html.slice(0, insertAt) + scriptTag + html.slice(insertAt)
  }
  return scriptTag + html
}

/**
 * WebView wrapper that hosts an arbitrary page with the
 * `browser-sniffer-injected` script installed pre-content-load.
 *
 * - Decoded messages reach the supplied `handlers` via
 *   `BridgeTransport`'s dispatch fiber — same machinery the rest of the
 *   slice cluster uses, so handler defects log without taking the page
 *   down and the scope tears down cleanly on unmount.
 * - The transport is built inside `useEffect`, so React's lifecycle
 *   owns the scope: on `handlers` identity change, the prior scope is
 *   `Scope.close`d before the next build runs (the `useMemo`-with-no-
 *   cleanup approach leaked a Scope + dispatch fiber per render).
 * - Host→Web (`CancelSnifferRequest` / `Click`) sends go through
 *   `webviewRef.current.postMessage(encoded)` — the bridge wires this
 *   in via the {@link TransportAdapter}'s `bareSender`. Sends that
 *   arrive before the WebView ref attaches are buffered and drained
 *   the moment the ref appears (rare; the bridge's own `__Ready` gate
 *   normally covers this window, but StrictMode double-mounts and
 *   post-unmount stragglers can race).
 * - Inbound `transport.enqueue` failures are logged rather than
 *   surfacing as unhandled promise rejections — useful when a torn-
 *   down transport sees a late inbound message.
 */
const BrowserSnifferWebView = forwardRef<BrowserSnifferWebViewHandle, BrowserSnifferWebViewProps>(
  function BrowserSnifferWebView({ source, handlers, loader }, ref): JSX.Element {
    const webviewRef = useRef<WebView | null>(null)
    const transportRef = useRef<TransportType | undefined>(undefined)
    const outboundBuffer = useRef<string[]>([])
    const [loaded, setLoaded] = useState(false)

    // Pre-process HTML sources to embed the sniffer. Uri sources flow
    // through unchanged and depend on `injectedJavaScriptBeforeContentLoaded`.
    const sniffableSource = useMemo<BrowserSnifferWebViewSource>(() => {
      if ('html' in source) {
        return { ...source, html: embedSnifferIntoHtml(source.html) }
      }
      return source
    }, [source])

    useEffect(() => {
      const scope = Effect.runSync(Scope.make())

      const bareSender: BareSenderFunction = (encoded) =>
        Effect.sync(() => {
          const wv = webviewRef.current
          if (wv === null) {
            outboundBuffer.current.push(encoded)
            return
          }
          // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
          wv.postMessage(encoded)
        })
      const adapter: TransportAdapter['Type'] = {
        bareSender,
        drainInitial: Effect.succeed([]),
      }
      const layer = BrowserSnifferBridge.Host.ReceiverLayer(handlers)
      const built = Effect.runSync(
        Scope.extend(
          BridgeTransport.make({
            bridges: [BrowserSnifferBridge] as const,
            layers: [layer] as const,
            side: 'Host',
          }).pipe(Effect.provide(Layer.succeed(TransportAdapter, adapter))),
          scope
        )
      )
      transportRef.current = built

      return (): void => {
        transportRef.current = undefined
        Effect.runFork(Scope.close(scope, Exit.void))
      }
    }, [handlers])

    // Callback ref: attach to WebView and drain any outbound messages
    // that piled up before the ref was wired (the bridge's own
    // `__Ready` Deferred normally prevents this, but StrictMode
    // double-mounts and React 18 concurrent rendering can race).
    const setWebviewRef = useCallback((wv: WebView | null): void => {
      webviewRef.current = wv
      if (wv === null || outboundBuffer.current.length === 0) return
      const buffered = outboundBuffer.current.splice(0)
      for (const enc of buffered) {
        // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
        wv.postMessage(enc)
      }
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        cancelRequest(id: string): void {
          const transport = transportRef.current
          // Pre-build / post-unmount: silently drop. The cancel has
          // no meaning without an attached transport, and the page
          // either hasn't received the corresponding id yet or has
          // already torn down its state.
          if (transport === undefined) return
          Effect.runFork(transport.sendMessage({ _tag: 'CancelSnifferRequest', id }))
        },
        click(querySelector: string): void {
          const transport = transportRef.current
          // Pre-build / post-unmount: silently drop. A click against a
          // not-yet-attached or torn-down page is meaningless; the host
          // will reissue on the next PageLoaded if needed.
          if (transport === undefined) return
          Effect.runFork(transport.sendMessage({ _tag: 'Click', querySelector }))
        },
      }),
      []
    )

    const onWebViewMessageEvent = (event: WebViewMessageEvent): void => {
      const raw = event.nativeEvent.data
      const transport = transportRef.current
      if (transport === undefined) return
      void Effect.runPromise(
        transport
          .enqueue(raw)
          .pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError('BrowserSnifferWebView.onMessage: transport.enqueue failed', cause)
            )
          )
      )
    }

    return (
      <View style={styles.container}>
        <WebView
          ref={setWebviewRef}
          source={sniffableSource}
          onMessage={onWebViewMessageEvent}
          onLoadEnd={(): void => setLoaded(true)}
          injectedJavaScriptBeforeContentLoaded={snifferScript}
          style={styles.webview}
          // `originWhitelist={['*']}` is a v1 shortcut: the WebView may
          // navigate to any origin (necessary because FHIR OAuth flows
          // redirect cross-origin). Combined with
          // `injectedJavaScriptBeforeContentLoaded`, the sniffer runs on
          // every origin visited inside this WebView. Issue #17 tracks
          // narrowing to a host-supplied whitelist prop.
          originWhitelist={['*']}
          javaScriptEnabled={true}
          domStorageEnabled={true}
        />
        {loader !== undefined && !loaded ? (
          <View style={styles.loaderOverlay}>{loader}</View>
        ) : null}
      </View>
    )
  }
)

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
  loaderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
})

export { BrowserSnifferWebView }
export type {
  BrowserSnifferWebViewHandle,
  BrowserSnifferWebViewProps,
  BrowserSnifferWebViewSource,
  SnifferHandlers,
}
