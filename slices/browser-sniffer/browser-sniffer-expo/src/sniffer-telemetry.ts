import { type SnifferHandlers } from 'browser-sniffer-core/bridge'
import * as Telemetry from 'browser-sniffer-core/telemetry'
import { Clock, Effect, Exit, Tracer } from 'effect'

/**
 * Span context of a remote trace to link the sniffer's root spans back
 * to — the `traceId` / `spanId` the collector SPA captured from its
 * active sync span and forwarded via `RequestSniffableWebView.linkedSpan`.
 * Threaded in by {@link makeSnifferTelemetry}; reconstructed with
 * {@link Tracer.externalSpan} and attached as a span *link* on every root
 * span the controller opens.
 */
interface LinkedSpanContext {
  readonly traceId: string
  readonly spanId: string
}

/**
 * Decoded message shapes, derived from the handler record so this module
 * never imports the wire schemas directly. Each is the argument type of
 * the matching {@link SnifferHandlers} member.
 */
type ResponseStartMsg = Parameters<SnifferHandlers['ResponseStart']>[0]
type ResponseDataMsg = Parameters<SnifferHandlers['ResponseData']>[0]
type PageLoadedMsg = Parameters<SnifferHandlers['PageLoaded']>[0]

/** A still-open response span plus the body bytes accrued so far. */
interface ResponseSpanState {
  readonly span: Tracer.Span
  bytes: number
}

/**
 * Stateful OpenTelemetry layer over a `BrowserSnifferBridge` host. Owns a
 * small tree of manually-managed spans whose lifetimes outlive any single
 * handler call (see `Effect.makeSpan`):
 *
 *  - a session span (mount → unmount): the in-process root that parents
 *    every span below and carries the single link back to the collector's
 *    sync trace,
 *  - an initial-load span (mount → first `PageLoaded`), child of the session,
 *  - one page span per settled page view (`PageLoaded` → next `PageLoaded`),
 *    child of the session,
 *  - one response span per in-flight request, nested under whichever
 *    page (or initial-load) span was open when it started.
 *
 * Span creation (`start`, and the `PageLoaded` / `ResponseStart` paths in
 * `wrap`) needs a real `Tracer` in fiber context; ending spans, accruing
 * bytes, and recording events do not. The created `Tracer.Span` objects
 * are plain values shared across fibers, so the dispatch fiber (where
 * `wrap`'s handlers run) and the mount/unmount fiber (where `start` /
 * `dispose` run) can hand spans to one another by reference.
 */
interface SnifferTelemetry {
  /**
   * Open the session root span and its initial-load child. Run once on
   * mount, on a fiber that has the real `Tracer` provided (see
   * `BridgedWebView`'s `runnerLayer`).
   */
  readonly start: Effect.Effect<void>
  /**
   * Wrap the consumer's handlers so each sniffer event drives the span
   * tree before delegating to the original handler. The returned handlers
   * must run on a `Tracer`-provided fiber (the dispatch fiber), since
   * `PageLoaded` / `ResponseStart` create spans.
   */
  readonly wrap: (handlers: SnifferHandlers) => SnifferHandlers
  /**
   * Record a synthetic-click span *event* on the current page span (or,
   * before the first `PageLoaded`, the initial-load span, falling back to
   * the session span). No-op only outside the session (before `start` /
   * after `dispose`). Needs no `Tracer` — it writes onto an existing span.
   */
  readonly recordClick: (selector: string) => Effect.Effect<void>
  /**
   * End every still-open span — all in-flight response spans (marked
   * aborted), the open page/initial-load span, then the session root. Run
   * on unmount. Needs no `Tracer`.
   */
  readonly dispose: Effect.Effect<void>
}

/**
 * Decoded byte length of a standard (RFC 4648, padded) base64 string,
 * computed from the string length without allocating the decoded bytes.
 * The sniffer base64-encodes response chunks via `btoa`, so the input is
 * always padded to a multiple of four.
 */
const base64ByteLength = (data: string): number => {
  if (data.length === 0) return 0
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

const makeSnifferTelemetry = (linkedSpan?: LinkedSpanContext): SnifferTelemetry => {
  // The session span is the in-process root for the whole component
  // lifetime (mount → unmount); it parents the initial-load and every page
  // span. The initial-load span lives until the first PageLoaded;
  // thereafter the current page span is the open child. At most one of the
  // two is "open" at any moment (see `openChild` below).
  let sessionSpan: Tracer.Span | null = null
  let initialLoadSpan: Tracer.Span | null = null
  let currentPageSpan: Tracer.Span | null = null
  // In-flight response spans, keyed by the request's correlation id.
  const responseSpans = new Map<string, ResponseSpanState>()

  // Set synchronously by `dispose`'s gate (see `dispose` and `BridgedWebView`'s
  // unmount cleanup). `start` provides a Layer — an async build step — so on a
  // fast unmount (or React StrictMode's mount→unmount→mount) the cleanup can
  // run before `start` has assigned `sessionSpan` / `initialLoadSpan`. Gating
  // `start` on this flag means a `start` that loses the race opens nothing,
  // rather than opening spans that `dispose` already missed and so never ends
  // (a leaked, never-flushed span).
  let disposed = false

  // Every span the controller opens is ended through `endSpan`, which is
  // idempotent per span: a terminal handler running on the dispatch fiber and
  // `dispose` running on the unmount fiber can both reach for the same span
  // (the dispatch fiber is forked, not provably interrupted before dispose),
  // and OTel double-ends overwrite the first status/duration with the second.
  // `WeakSet` membership records "already ended" without retaining the spans.
  const endedSpans = new WeakSet<Tracer.Span>()
  const endSpan = (span: Tracer.Span, endTime: bigint, exit: Exit.Exit<unknown, unknown>): void => {
    if (endedSpans.has(span)) return
    endedSpans.add(span)
    span.end(endTime, exit)
  }

  // Span link back to the collector's sync trace, applied to the session
  // span only. Every other span descends from the session in-process, so
  // they share its trace and need no link of their own. (Sentry promotes a
  // span with a *remote* parent to its own trace, so the link has to ride
  // the in-process root, not each page span.) Empty when no `linkedSpan`
  // was forwarded — `makeSpan` treats `links: []` as a no-op.
  const sessionLinks: ReadonlyArray<Tracer.SpanLink> =
    linkedSpan === undefined
      ? []
      : [
          {
            _tag: 'SpanLink',
            span: Tracer.externalSpan({
              traceId: linkedSpan.traceId,
              spanId: linkedSpan.spanId,
            }),
            attributes: {},
          },
        ]

  // Parent for new response spans / click events: the open page span, or
  // — before the first PageLoaded — the initial-load span, falling back to
  // the session span (e.g. a click before initial-load settles).
  const currentParent = (): Tracer.Span | null => currentPageSpan ?? initialLoadSpan ?? sessionSpan

  const start: Effect.Effect<void> = Effect.gen(function* () {
    // `start` provides a Layer (an async build step) before this body runs, so
    // a fast unmount can flip `disposed` while it is still building. If the
    // gate already closed, open nothing — otherwise the session / initial-load
    // spans would be created after `dispose` already ran and so never get
    // ended (and never flushed). See the `disposed` declaration above.
    if (disposed) return
    const session = yield* Effect.makeSpan(Telemetry.Sniffing.Session.Span.Name, {
      root: true,
      links: sessionLinks,
    })
    const initialLoad = yield* Effect.makeSpan(Telemetry.Sniffing.InitialLoad.Span.Name, {
      parent: session,
    })
    // `makeSpan` is a yield point, so `dispose` could have flipped `disposed`
    // (and ended whatever it saw — nothing, since these aren't published yet)
    // while these spans were being built. Re-check before publishing: if the
    // gate closed mid-flight, end the freshly-opened pair here so they don't
    // leak. `endSpan` keeps this safe even if `dispose` somehow saw them.
    if (disposed) {
      const now = yield* Clock.currentTimeNanos
      endSpan(initialLoad, now, Exit.void)
      endSpan(session, now, Exit.void)
      return
    }
    sessionSpan = session
    initialLoadSpan = initialLoad
  })

  const rotatePage = (message: PageLoadedMsg): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeNanos
      // End the open child: the initial-load span on the first PageLoaded,
      // the prior page span on every subsequent one. In-flight response
      // spans are deliberately left open — they settle on their own
      // terminal event, or are aborted on unmount.
      const openChild = currentPageSpan ?? initialLoadSpan
      if (openChild !== null) endSpan(openChild, now, Exit.void)
      initialLoadSpan = null
      const attributes = {
        [Telemetry.Sniffing.Attributes.UrlFull]: message.url,
        [Telemetry.Sniffing.Attributes.PageContentId]: message.pageContentId,
      }
      // Parent to the session span so every page shares its trace. The
      // null-session guard is defensive — `start` always opens the session
      // before any `PageLoaded` can arrive.
      currentPageSpan = yield* Effect.makeSpan(
        Telemetry.Sniffing.Page.Span.Name,
        sessionSpan === null ? { attributes } : { attributes, parent: sessionSpan }
      )
    })

  const openResponse = (message: ResponseStartMsg): Effect.Effect<void> =>
    Effect.gen(function* () {
      const parent = currentParent()
      const attributes = {
        [Telemetry.Sniffing.Attributes.RequestId]: message.id,
        [Telemetry.Sniffing.Attributes.UrlFull]: message.url,
        [Telemetry.Sniffing.Attributes.HttpResponseStatusCode]: message.status,
        [Telemetry.Sniffing.Attributes.HttpResponseStatusText]: message.statusText,
      }
      const span = yield* Effect.makeSpan(
        Telemetry.Sniffing.Response.Span.Name,
        parent === null ? { attributes } : { attributes, parent }
      )
      responseSpans.set(message.id, { span, bytes: 0 })
    })

  const accrueBytes = (message: ResponseDataMsg): Effect.Effect<void> =>
    Effect.sync(() => {
      const entry = responseSpans.get(message.id)
      if (entry === undefined) return
      entry.bytes += base64ByteLength(message.data)
      entry.span.attribute(Telemetry.Sniffing.Attributes.HttpResponseBodySize, entry.bytes)
    })

  // Close a tracked response span with a terminal outcome. No-op if the id
  // is unknown (a terminal event for an already-settled or never-started
  // request).
  const endResponse = (
    id: string,
    outcome: string,
    exit: Exit.Exit<unknown, unknown>,
    decorate?: (span: Tracer.Span) => void
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entry = responseSpans.get(id)
      if (entry === undefined) return
      const now = yield* Clock.currentTimeNanos
      entry.span.attribute(Telemetry.Sniffing.Attributes.Outcome, outcome)
      decorate?.(entry.span)
      endSpan(entry.span, now, exit)
      responseSpans.delete(id)
    })

  const recordClick = (selector: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const parent = currentParent()
      if (parent === null) return
      const now = yield* Clock.currentTimeNanos
      parent.event(Telemetry.Sniffing.Click.Event.Name, now, {
        [Telemetry.Sniffing.Attributes.ClickSelector]: selector,
      })
    })

  const dispose: Effect.Effect<void> = Effect.gen(function* () {
    // Close the start-gate synchronously, as the very first action: when run
    // via `Effect.runFork` (the unmount cleanup), the gen's synchronous prefix
    // executes eagerly, so a `start` racing this dispose sees `disposed` and
    // opens nothing. Set before the first yield point so no async hop can slip
    // a span past the gate. (See `disposed` and `start`.)
    disposed = true
    const now = yield* Clock.currentTimeNanos
    for (const { span } of responseSpans.values()) {
      span.attribute(Telemetry.Sniffing.Attributes.Outcome, Telemetry.Sniffing.Outcomes.Aborted)
      // `endSpan` (not `span.end`) so a terminal handler that closed this same
      // response span on the dispatch fiber can't be double-ended here.
      endSpan(span, now, Exit.void)
    }
    responseSpans.clear()
    // End inside-out: the open page/initial-load child first, then the
    // session root. The session must end last — it's the transaction Sentry
    // sends, and ending it flushes the whole buffered subtree. `endSpan`
    // guards each against a concurrent / re-entrant close.
    const openChild = currentPageSpan ?? initialLoadSpan
    if (openChild !== null) endSpan(openChild, now, Exit.void)
    if (sessionSpan !== null) endSpan(sessionSpan, now, Exit.void)
    currentPageSpan = null
    initialLoadSpan = null
    sessionSpan = null
  })

  const wrap = (handlers: SnifferHandlers): SnifferHandlers => ({
    ResponseStart: (message) =>
      openResponse(message).pipe(Effect.zipRight(handlers.ResponseStart(message))),
    ResponseData: (message) =>
      accrueBytes(message).pipe(Effect.zipRight(handlers.ResponseData(message))),
    ResponseFinished: (message) =>
      endResponse(message.id, Telemetry.Sniffing.Outcomes.Finished, Exit.void).pipe(
        Effect.zipRight(handlers.ResponseFinished(message))
      ),
    RequestError: (message) =>
      endResponse(
        message.id,
        Telemetry.Sniffing.Outcomes.Error,
        Exit.fail(message.message),
        (span) => {
          span.attribute(Telemetry.Sniffing.Attributes.ErrorType, 'RequestError')
          span.attribute(Telemetry.Sniffing.Attributes.ErrorMessage, message.message)
          span.attribute(Telemetry.Sniffing.Attributes.UrlFull, message.url)
        }
      ).pipe(Effect.zipRight(handlers.RequestError(message))),
    Cancelled: (message) =>
      endResponse(message.id, Telemetry.Sniffing.Outcomes.Cancelled, Exit.void).pipe(
        Effect.zipRight(handlers.Cancelled(message))
      ),
    PageLoaded: (message) =>
      rotatePage(message).pipe(Effect.zipRight(handlers.PageLoaded(message))),
  })

  return { start, wrap, recordClick, dispose }
}

export { makeSnifferTelemetry }
export type { LinkedSpanContext, SnifferTelemetry }
