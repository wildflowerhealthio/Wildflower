import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { Effect } from 'effect'
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
 * Typed host-side sender for {@link BrowserSnifferBridge}. The
 * sniffer ref exposes this so callers can issue `Click` /
 * `CancelSnifferRequest` against the sniffed page.
 *
 * @remarks
 * `Effect`-returning by design: each call suspends on the bridge's
 * `__Ready` handshake (the sniffer's first `__Ready` post resolves
 * the gate). Wrap in `Effect.runFork` at the call site for a
 * fire-and-forget send.
 *
 * **The pre-mount drop is only observable when the caller actually
 * runs the returned Effect.** A `runFork`/`runPromise` lands an
 * `Effect.logError` on `Logger.defaultLogger`; a caller that
 * constructs the Effect but never executes it loses the diagnostic
 * silently.
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
   * Handler for page-side `console.<level>(...)` calls mirrored over
   * {@link LogBridge.LogBridge}. Omit to fall back to
   * {@link LogBridge.defaultOnLog} (routes through the host's Effect
   * logger at the matching level — what most callers want).
   *
   * **Memoization required.** A fresh function literal on every
   * render rebuilds the binding (and the underlying transport, via
   * {@link BridgedWebView}'s `bindings`-identity rebuild rule). Wrap
   * in `useCallback` upstream.
   */
  readonly onLog?: (msg: LogBridge.LogPayload) => Effect.Effect<void>
  /**
   * Per-tag handler record for sniffer events (`ResponseStart`,
   * `ResponseData`, `PageLoaded`, etc.). See {@link SnifferHandlers}.
   *
   * **Memoization required.** Same constraint as `onLog` — a fresh
   * record on every render rebuilds the transport.
   */
  readonly browserSnifferHandlers: SnifferHandlers
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

/**
 * WebView that hosts an arbitrary third-party page with the
 * `browser-sniffer-injected` script installed pre-content-load,
 * built as a thin wrapper around {@link BridgedWebView} with
 * {@link BrowserSnifferBridge} and {@link LogBridge.LogBridge}
 * composed into the same transport.
 *
 * @remarks
 * - **Decoded sniffer events** reach `browserSnifferHandlers` via
 *   `BridgedWebView`'s dispatch fiber.
 * - **Page-side `console.<level>(...)`** is mirrored over
 *   {@link LogBridge.LogBridge} and surfaces through `onLog` (or
 *   {@link LogBridge.defaultOnLog} when the prop is omitted).
 * - **Host→Web sends** (`Click`, `CancelSnifferRequest`) go through
 *   the typed sender exposed via `ref` — call with the decoded
 *   message and wrap in `Effect.runFork` at the call site. The
 *   sender suspends on the page's `__Ready` post; pre-mount calls
 *   drop with a logged error.
 * - **Every navigation stays in-WebView.** No `shouldOpenInSystemBrowser`
 *   predicate is passed through, so the underlying `TransportWebView`'s
 *   default (always in-WebView) keeps FHIR OAuth cross-origin
 *   redirects from escaping to the system browser.
 */
const BrowserSnifferWebView = forwardRef<BrowserSnifferMessageSender, BrowserSnifferWebViewProps>(
  function BrowserSnifferWebView(
    { loadFrom, loader, onLog, browserSnifferHandlers },
    ref
  ): JSX.Element {
    const senderRef = useRef<BrowserSnifferMessageSender | null>(null)

    const snifferBinding = useMemo<HostBinding.HostBinding<typeof BrowserSnifferBridge>>(
      () => ({
        bridge: BrowserSnifferBridge,
        receiverLayer: BrowserSnifferBridge.Host.ReceiverLayer(browserSnifferHandlers),
        onTransportReady: (send) =>
          Effect.sync(() => {
            senderRef.current = send
          }),
      }),
      [browserSnifferHandlers]
    )

    const logBinding = useLogHostBinding({ onLog })

    // `BridgedWebView` keys its transport rebuild on `bindings`
    // identity, so the tuple must be memoised even though both deps
    // are already stable.
    const bindings = useMemo(
      () => [snifferBinding, logBinding] as const,
      [snifferBinding, logBinding]
    )

    // Loud over silent: pre-mount calls log an error rather than
    // dropping invisibly.
    const stableSender = useCallback<BrowserSnifferMessageSender>(
      (message) =>
        Effect.suspend(() => {
          const send = senderRef.current
          if (send === null) {
            return Effect.logError(
              '[browser-sniffer-expo] dropped pre-mount message; the transport is not ready yet',
              { tag: message._tag }
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
      />
    )
  }
)

export { BrowserSnifferWebView }
export type { BrowserSnifferMessageSender, BrowserSnifferWebViewProps, SnifferHandlers }
