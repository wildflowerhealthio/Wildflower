import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { type Context, Effect } from 'effect'
import {
  type BridgeTransport,
  type HostBinding,
  type LogBridge,
  type MessageHandler,
} from 'effect-messaging-core'
import {
  BridgedWebView,
  type BridgedWebViewLoadFrom,
  useLogHostBinding,
} from 'effect-messaging-expo'
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, type JSX } from 'react'

/**
 * Per-tag handler record for the `Web→Host` messages
 * {@link BrowserSnifferBridge} carries. Each handler returns an
 * `Effect<void>`; the dispatch fiber catches handler defects so a
 * throw from one handler doesn't tear down the rest.
 */
type SnifferHandlers = MessageHandler.HandlersFor<typeof BrowserSnifferBridge.Host.InboundSchemas>

/**
 * Per-tag handler record for `LogBridge` (just `{ Log }`). Exposed as
 * a prop so consumers choose what to do with page-side
 * `console.<level>(...)` calls — surface through the host's Effect
 * logger via {@link LogBridge.defaultOnLog}, route into a custom
 * telemetry sink, or drop entirely.
 */
type LogHandlers = Context.Tag.Service<typeof LogBridge.LogBridge.Host.HandlerTag>

/**
 * Typed host-side sender for {@link BrowserSnifferBridge}. The
 * sniffer ref exposes this so callers can issue `Click` /
 * `CancelSnifferRequest` against the sniffed page.
 *
 * @remarks
 * `Effect`-returning by design: each call suspends on the bridge's
 * `__Ready` handshake (the sniffer's first `__Ready` post resolves
 * the gate). Wrap in `Effect.runFork` at the call site for a
 * fire-and-forget send.
 */
type BrowserSnifferMessageSender = BridgeTransport.MessageSender<
  readonly [typeof BrowserSnifferBridge],
  'Host'
>

interface BrowserSnifferWebViewProps {
  /**
   * Page to sniff. Mirrors {@link BridgedWebViewLoadFrom}: `uri` for a
   * remote page, `html` for inline content with mandatory `baseUrl`.
   * HTML sources get the sniffer script embedded directly into the
   * document before mount (Android-reliability fix); URI sources rely
   * on react-native-webview's `injectedJavaScriptBeforeContentLoaded`.
   */
  readonly loadFrom: BridgedWebViewLoadFrom
  /** Element rendered on top of the WebView until its first `onLoadEnd` fires. */
  readonly loader?: JSX.Element
  /**
   * Handler for the `LogBridge`'s `Log` messages — page-side
   * `console.<level>(...)` calls re-emitted as typed bridge
   * messages. Pass `LogBridge.defaultOnLog` to route through the
   * host's Effect logger at the matching level.
   *
   * **Memoization required.** A fresh function literal on every
   * render rebuilds the binding (and the underlying transport, via
   * {@link BridgedWebView}'s `bindings`-identity rebuild rule). Wrap
   * in `useMemo`/`useCallback` upstream.
   */
  readonly logHandler: LogHandlers
  /**
   * Per-tag handler record for sniffer events (`ResponseStart`,
   * `ResponseData`, `PageLoaded`, etc.). See {@link SnifferHandlers}.
   *
   * **Memoization required.** Same constraint as `logHandler` — a
   * fresh record on every render rebuilds the transport.
   */
  readonly browserSnifferHandler: SnifferHandlers
}

/**
 * For HTML sources, embed the sniffer script directly into the
 * document (after `<head>`, or prepended when no `<head>` tag is
 * present) in addition to react-native-webview's
 * `injectedJavaScriptBeforeContentLoaded` prop. The prop is
 * unreliable on some Android builds and on responses the WebView
 * doesn't parse as HTML; embedding into the document guarantees the
 * sniffer runs before any page `<script>` on every platform.
 * Idempotent: the sniffer's `Symbol.for('browser-sniffer:state')`
 * slot makes a second install a no-op.
 *
 * For Uri sources we can't embed (the remote page is whatever it
 * is), so those still rely on the injection prop. That's the
 * original use case the prop was reliable for.
 */
const embedSnifferIntoHtml = (html: string): string => {
  const scriptTag = `<script>${snifferScript}</script>`
  // Insert right after `<head…>` so the sniffer runs before any other
  // `<script>` in `<head>` or `<body>`. Fall back to prepend (which
  // may trigger quirks mode if a doctype follows, but functional for
  // our injection purpose).
  const headMatch = /<head[^>]*>/i.exec(html)
  if (headMatch !== null) {
    const insertAt = headMatch.index + headMatch[0].length
    return html.slice(0, insertAt) + scriptTag + html.slice(insertAt)
  }
  return scriptTag + html
}

// Sniffed pages frequently redirect cross-origin (e.g. FHIR OAuth
// flows). Override `TransportWebView`'s default same-origin gate to
// keep every navigation in-WebView. Module-level so the identity is
// stable across renders.
const alwaysInWebView = (): boolean => true

/**
 * WebView that hosts an arbitrary third-party page with the
 * `browser-sniffer-injected` script installed pre-content-load,
 * built as a thin wrapper around {@link BridgedWebView} with
 * {@link BrowserSnifferBridge} and {@link LogBridge.LogBridge}
 * composed into the same transport.
 *
 * @remarks
 * - **Decoded sniffer events** reach `browserSnifferHandler` via
 *   `BridgedWebView`'s dispatch fiber.
 * - **Page-side `console.<level>(...)`** is mirrored over
 *   {@link LogBridge.LogBridge} and surfaces through `logHandler`.
 * - **Host→Web sends** (`Click`, `CancelSnifferRequest`) go through
 *   the typed sender exposed via `ref` — call with the decoded
 *   message and wrap in `Effect.runFork` at the call site. The
 *   sender suspends on the page's `__Ready` post; pre-mount calls
 *   drop with a logged error.
 * - **Cross-origin navigations** stay in-WebView (necessary for
 *   FHIR OAuth flows). The sniffer overrides
 *   `TransportWebView`'s default same-origin gate.
 */
const BrowserSnifferWebView = forwardRef<BrowserSnifferMessageSender, BrowserSnifferWebViewProps>(
  function BrowserSnifferWebView(
    { loadFrom, loader, logHandler, browserSnifferHandler },
    ref
  ): JSX.Element {
    const senderRef = useRef<BrowserSnifferMessageSender | null>(null)

    const snifferBinding = useMemo<HostBinding.HostBinding<typeof BrowserSnifferBridge>>(
      () => ({
        bridge: BrowserSnifferBridge,
        receiverLayer: BrowserSnifferBridge.Host.ReceiverLayer(browserSnifferHandler),
        // The binding's `onTransportReady` receives the per-bridge
        // typed sender. Capture it into the ref so the imperative
        // handle below can delegate to it.
        onTransportReady: (send) =>
          Effect.sync(() => {
            senderRef.current = send
          }),
      }),
      [browserSnifferHandler]
    )

    const logBinding = useLogHostBinding({ onLog: logHandler.Log })

    const bindings = useMemo(
      () => [snifferBinding, logBinding] as const,
      [snifferBinding, logBinding]
    )

    // Stable ref-exposed sender: when called before the transport's
    // `onTransportReady` has fired, the message drops and an error
    // logs (so a misuse is loud, not silent). Once the sender is
    // captured, every call delegates straight to it — including the
    // sender's own `__Ready` suspension semantics.
    const stableSender = useCallback<BrowserSnifferMessageSender>(
      (message) =>
        Effect.suspend(() => {
          const send = senderRef.current
          if (send === null) {
            return Effect.logError(
              `BrowserSnifferWebView: dropped pre-mount message ${message._tag}; the transport is not ready yet.`
            )
          }
          return send(message)
        }),
      []
    )
    useImperativeHandle(ref, () => stableSender, [stableSender])

    const sniffableLoadFrom = useMemo<BridgedWebViewLoadFrom>(
      () =>
        loadFrom._tag === 'html'
          ? { ...loadFrom, html: embedSnifferIntoHtml(loadFrom.html) }
          : loadFrom,
      [loadFrom]
    )

    // `sniffableLoadFrom` (the embedded `<script>` for html sources)
    // and `injectedJavaScriptBeforeContentLoaded` cover *different*
    // cases, not the same case twice:
    //   • Uri sources: `embedSnifferIntoHtml` is a no-op (nothing to
    //     rewrite), so the injection prop is the only install path.
    //   • Html sources: the embedded `<script>` is the reliable path
    //     (RN-WebView's injection prop is flaky on some Android
    //     builds, and silently no-ops on responses it doesn't parse
    //     as HTML); the injection prop comes along for the ride as
    //     a belt-and-braces fallback for the platforms where it does
    //     fire.
    // A double-install on html is harmless because `installSniffer`'s
    // `Symbol.for('browser-sniffer:state')` slot short-circuits the
    // second call (`install-sniffer.ts` line 129).
    return (
      <BridgedWebView
        bindings={bindings}
        loadFrom={sniffableLoadFrom}
        loader={loader}
        injectedJavaScriptBeforeContentLoaded={snifferScript}
        shouldHandleInWebView={alwaysInWebView}
      />
    )
  }
)

export { BrowserSnifferWebView }
export type {
  BrowserSnifferMessageSender,
  BrowserSnifferWebViewProps,
  LogHandlers,
  SnifferHandlers,
}
