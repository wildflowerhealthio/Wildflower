import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { Effect, Exit, Layer, Scope } from 'effect'
import {
  BridgeTransport,
  LogBridge,
  type MessageHandler,
  TransportAdapter,
  type BareSenderFunction,
} from 'effect-messaging-core'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
 *
 * `postRaw(rawWire)` injects a *pre-encoded* bridge wire string
 * directly into the page, bypassing the typed
 * `BridgeTransport.sendMessage` encode step. Use this to forward
 * messages that arrived already-encoded from a paired transport
 * (e.g. the collector SPA's outbound `Click` / `CancelSnifferRequest`)
 * without paying for a decode + re-encode round trip in the native
 * host. Caller is responsible for the wire format being a valid
 * `BrowserSnifferBridge` host→web payload — malformed strings are
 * silently dropped by the page's bridge dispatcher.
 */
interface BrowserSnifferWebViewHandle {
  cancelRequest(id: string): void
  click(querySelector: string): void
  postRaw(rawWire: string): void
}

/** What the WebView should load. Mirrors `TransportWebViewSource`. */
type BrowserSnifferWebViewSource = { uri: string } | { html: string; baseUrl?: string }

type SnifferHandlers = MessageHandler.HandlersFor<typeof BrowserSnifferBridge.Host.InboundSchemas>

type TransportType = Effect.Effect.Success<
  ReturnType<
    typeof BridgeTransport.make<readonly [typeof BrowserSnifferBridge, typeof LogBridge], 'Host'>
  >
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
  /**
   * Optional pre-decode hook fired with the raw wire string for every
   * inbound bridge message *in addition to* the typed dispatch via
   * `handlers`. Wire this when an outer transport speaks the same
   * wire format (e.g. the collector SPA's `CollectorBridge` reuses
   * `BrowserSnifferBridge`'s sniffer-event schemas) and you want to
   * forward verbatim without paying for a decode + re-encode round
   * trip in the host. Returns synchronously — slow consumers should
   * fork their own fiber.
   */
  readonly onRawMessage?: (rawWire: string) => void
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
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
 * - Host→Web (`CancelSnifferRequest`) sends go through
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
  function BrowserSnifferWebView({ source, handlers, onRawMessage, loader }, ref): JSX.Element {
    const webviewRef = useRef<WebView | null>(null)
    const transportRef = useRef<TransportType | undefined>(undefined)
    const outboundBuffer = useRef<string[]>([])
    const [loaded, setLoaded] = useState(false)

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
      const snifferLayer = BrowserSnifferBridge.Host.ReceiverLayer(handlers)
      // LogBridge rides on the same transport as BrowserSnifferBridge —
      // the injected sniffer's `{_tag:'Log',level,payload}` wire shape
      // matches LogBridge's schema verbatim, so adding the bridge here
      // is enough to route page-side console output through the host's
      // Effect logger. Browser-sniffer-expo deliberately does not
      // surface this bridge to its caller; the default receiver is
      // always what callers want for an injected-sniffer setting.
      const built = Effect.runSync(
        Scope.extend(
          BridgeTransport.make({
            bridges: [BrowserSnifferBridge, LogBridge] as const,
            layers: [snifferLayer, LogBridge.defaultHostReceiverLayer] as const,
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
        postRaw(rawWire: string): void {
          // Goes through the same `bareSender`-style buffer the typed
          // path uses (so pre-attach sends queue and drain on ref
          // arrival), but skips the Schema.encode step. Callers that
          // received an already-encoded wire payload from a paired
          // bridge use this to forward verbatim.
          const wv = webviewRef.current
          if (wv === null) {
            outboundBuffer.current.push(rawWire)
            return
          }
          // oxlint-disable-next-line eslint-plugin-unicorn/require-post-message-target-origin
          wv.postMessage(rawWire)
        },
      }),
      []
    )

    const onWebViewMessageEvent = (event: WebViewMessageEvent): void => {
      const raw = event.nativeEvent.data
      // Fire the raw passthrough BEFORE the typed dispatch so a consumer
      // forwarding to a paired transport sees messages in the same order
      // the typed handlers would. Typed dispatch still runs — consumers
      // typically supply no-op typed handlers for tags they forward via
      // `onRawMessage`, but the wiring is independent so observation-only
      // handlers (e.g. `RequestError` firing `onError`) keep working.
      if (onRawMessage !== undefined) onRawMessage(raw)
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
          source={source}
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
