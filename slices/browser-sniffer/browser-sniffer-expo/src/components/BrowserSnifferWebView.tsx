import { BrowserSnifferBridge, type SnifferHandlers } from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { Effect } from 'effect'
import { type BridgeTransport, HostBindings, type Logging } from 'effect-messaging-core'
import {
  BridgedWebView,
  type BridgedWebViewLoadFrom,
  useLogHostBinding,
} from 'effect-messaging-expo'
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
import { reactNativeTelemetryLayerFromEnv } from 'telemetry-react-native'
import { type LinkedSpanContext, makeSnifferTelemetry } from '../sniffer-telemetry.ts'

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
  'HostToWeb'
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
  /**
   * Handler for page-side `console.<level>(...)` calls mirrored over
   * {@link Logging.LogBridge}. Omit to fall back to
   * {@link Logging.defaultOnLog} (routes through the host's Effect
   * logger at the matching level — what most callers want).
   *
   * **Memoization required.** A fresh function literal on every
   * render rebuilds the binding (and the underlying transport, via
   * {@link BridgedWebView}'s `bindings`-identity rebuild rule). Wrap
   * in `useCallback` upstream.
   */
  readonly onLog?: (msg: Logging.LogPayload) => Effect.Effect<void>
  /**
   * Per-tag handler record for sniffer events (`ResponseStart`,
   * `ResponseData`, `PageLoaded`, etc.). See {@link SnifferHandlers}.
   *
   * **Memoization required.** Same constraint as `onLog` — a fresh
   * record on every render rebuilds the transport.
   */
  readonly browserSnifferHandlers: SnifferHandlers
  /**
   * Optional span context of a remote trace (typically the collector's
   * sync span, forwarded via `RequestSniffableWebView.linkedSpan`). When
   * present, each root span this component opens — the initial-load span
   * and every per-page span — carries a span *link* back to it, so the
   * sniffer's independent per-page traces relate to the originating trace.
   *
   * Sampled once at mount: the controller that owns the span tree is
   * created on first render, so a later identity change is ignored. The
   * value travels with the page being sniffed, which mounts a fresh
   * component, so this matches the intended lifetime.
   */
  readonly linkedSpan?: LinkedSpanContext
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
 * {@link BrowserSnifferBridge} and {@link Logging.LogBridge}
 * composed into the same transport.
 *
 * @remarks
 * - **Decoded sniffer events** reach `browserSnifferHandlers` via
 *   `BridgedWebView`'s dispatch fiber.
 * - **Page-side `console.<level>(...)`** is mirrored over
 *   {@link Logging.LogBridge} and surfaces through `onLog` (or
 *   {@link Logging.defaultOnLog} when the prop is omitted).
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
    { loadFrom, onLog, browserSnifferHandlers, linkedSpan },
    ref
  ): JSX.Element {
    const senderRef = useRef<BrowserSnifferMessageSender | null>(null)

    // One stateful span controller per mount. Owns the initial-load / page
    // / response span tree; `wrap` decorates the consumer's handlers, and
    // mount/unmount drive `start` / `dispose` below. `linkedSpan` is read
    // once here (lazy init) and baked into every root span's link set.
    const [telemetry] = useState(() => makeSnifferTelemetry(linkedSpan))

    // The OTel layer is provided both to the runner (so the dispatch fiber
    // where the wrapped handlers run sees a real `Tracer`) and to the
    // mount-time `start` run below. Same layer object on both paths so the
    // initial-load span and the handler-created spans share one provider.
    const telemetryLayer = useMemo(() => reactNativeTelemetryLayerFromEnv(), [])

    // Decorate the consumer's handlers with span lifecycle. Recomputed when
    // the consumer flips `browserSnifferHandlers` (a transport
    // `registerHandlers` swap, not a rebuild); the controller's span state
    // persists across the swap because the controller itself is stable.
    const tracedHandlers = useMemo(
      () => telemetry.wrap(browserSnifferHandlers),
      [telemetry, browserSnifferHandlers]
    )

    const snifferBindings = useMemo(
      () =>
        HostBindings.single({
          bridge: BrowserSnifferBridge,
          handlers: tracedHandlers,
          onPageReady: (send) =>
            Effect.sync(() => {
              senderRef.current = send
            }),
        }),
      [tracedHandlers]
    )

    const logBindings = useLogHostBinding({ onLog })

    // `BridgedWebView` keys its transport rebuild on `bindings`
    // identity, so the merged value must be memoised even though both
    // deps are already stable.
    const bindings = useMemo(
      () => HostBindings.combine([snifferBindings, logBindings]),
      [snifferBindings, logBindings]
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
          // A Click is recorded as a span event on the current page (or
          // initial-load) span; CancelSnifferRequest carries no telemetry.
          const recordEvent =
            message._tag === 'Click' ? telemetry.recordClick(message.querySelector) : Effect.void
          return recordEvent.pipe(Effect.zipRight(send(message)))
        }),
      [telemetry]
    )
    useImperativeHandle(ref, () => stableSender, [stableSender])

    // Open the initial-load span on mount (under a real Tracer via the
    // provided layer) and close the whole open span tree on unmount.
    // `dispose` is pure span mutation, so it runs on the bare default
    // runtime even though the runner fiber is already being interrupted.
    //
    // Both runs are unsynchronised forks, and `start` provides a Layer (an
    // async build step), so on a fast unmount — or React StrictMode's
    // mount→unmount→mount — the cleanup can fire before `start` has opened its
    // spans. `dispose` guards against that by closing a synchronous start-gate
    // as its first action: `Effect.runFork` executes the gen's synchronous
    // prefix eagerly, so by the time this cleanup returns the gate is shut and
    // a `start` that loses the race opens nothing (it would otherwise leak an
    // unended, never-flushed span). See `makeSnifferTelemetry`'s `disposed`.
    useEffect(() => {
      Effect.runFork(Effect.provide(telemetry.start, telemetryLayer))
      return (): void => {
        Effect.runFork(telemetry.dispose)
      }
    }, [telemetry, telemetryLayer])

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
        injectedJavaScriptBeforeContentLoaded={snifferScript}
        runnerLayer={telemetryLayer}
      />
    )
  }
)

export { BrowserSnifferWebView }
export type {
  BrowserSnifferMessageSender,
  BrowserSnifferWebViewProps,
  LinkedSpanContext,
  SnifferHandlers,
}
