/**
 * Central catalog of OpenTelemetry span names, event names, and attribute
 * keys for the browser-sniffer host adapter. Kept in one file — even
 * though the spans fire from the platform adapter
 * (`browser-sniffer-tauri-rust` plus its TS bootstrap), not this pure
 * core — so the naming philosophy stays coherent in a single place,
 * the same way `collector-fundamentals/telemetry` centralises the
 * collector's.
 *
 * The adapter opens a small tree of manually-managed spans (see
 * `Effect.makeSpan`) whose lifetimes outlive any single handler call, so
 * the catalog leans on plain names + attribute keys rather than the
 * `withSpan`-style auto-closed spans used elsewhere:
 *
 *  - {@link Sniffing.Session} — root span for the whole component lifetime
 *    (mount → unmount); carries the link back to the collector's
 *    originating trace and parents every span below.
 *  - {@link Sniffing.InitialLoad} — child of the session span, from mount
 *    until the first `PageLoaded` (the host shell's first document fetch window).
 *  - {@link Sniffing.Page} — child of the session span per settled page
 *    view, from one `PageLoaded` to the next.
 *  - {@link Sniffing.Response} — child of whichever page span (or the
 *    initial-load span before the first `PageLoaded`) was open when the
 *    request started; spans one `ResponseStart` → `ResponseFinished` /
 *    `RequestError` / `Cancelled`, accruing body bytes from `ResponseData`.
 *  - {@link Sniffing.Click} — a span *event* (not its own span) recorded
 *    on the currently-open page / initial-load span, since a synthetic
 *    click is instantaneous.
 *
 * Attribute values prefer OpenTelemetry semantic conventions where one
 * exists (`url.full`, `http.response.status_code`, …); everything
 * browser-sniffer-specific is namespaced under `browser_sniffer.*`.
 */

/**
 * The host driving a sniffed page through `BrowserSnifferBridge` —
 * page-view spans, per-request response spans, and the synthetic-click
 * event the host fires against the page.
 */
const Sniffing = {
  /** Attribute keys shared across the sniffing spans/events. */
  Attributes: {
    /** OTel semconv: full URL of the page (`Page`) or request (`Response`). */
    UrlFull: 'url.full',
    /** OTel semconv: HTTP response status code. */
    HttpResponseStatusCode: 'http.response.status_code',
    /** OTel semconv: size in bytes of the (decoded) response body,
     * accrued across the request's `ResponseData` chunks. */
    HttpResponseBodySize: 'http.response.body.size',
    /** OTel semconv: error class/identifier when a request fails. */
    ErrorType: 'error.type',
    /** Free-form failure detail from the page's `RequestError`. No OTel
     * semconv key covers a human-readable network error string. */
    ErrorMessage: 'browser_sniffer.error.message',
    /** HTTP response status text — no OTel semconv key exists. */
    HttpResponseStatusText: 'browser_sniffer.response.status_text',
    /** Per-request correlation id (the `Response*`/`Cancelled` triple's `id`). */
    RequestId: 'browser_sniffer.request.id',
    /** Correlation id of a page's content stream (`PageLoaded.pageContentId`). */
    PageContentId: 'browser_sniffer.page.content_id',
    /** `querySelector` targeted by a host→web `Click`. */
    ClickSelector: 'browser_sniffer.click.selector',
    /** How a span closed — see {@link Sniffing.Outcomes}. */
    Outcome: 'browser_sniffer.outcome',
  },
  /**
   * Terminal-state markers for the {@link Sniffing.Response} span, written
   * to {@link Sniffing.Attributes.Outcome} so a closed span records *why*
   * it closed even when the OTel exit status alone can't distinguish (e.g.
   * a clean finish vs a page-teardown abort both end without an error).
   */
  Outcomes: {
    /** `ResponseFinished` — the stream completed naturally. */
    Finished: 'finished',
    /** `RequestError` — the page reported a network/fetch failure. */
    Error: 'error',
    /** `Cancelled` — terminal ack of a mid-stream `CancelSnifferRequest`. */
    Cancelled: 'cancelled',
    /** The component unmounted with the request still in flight. */
    Aborted: 'aborted',
  },
  /**
   * The whole component lifetime: mount → unmount. The root span that
   * parents every other sniffing span, and the only span carrying the link
   * back to the collector's originating sync trace — so the sniffer's
   * activity reads as one trace, related to the collector once. (Sentry
   * promotes a span with a *remote* parent to its own trace, so the link
   * has to ride this in-process root, not each page span.)
   */
  Session: {
    Span: { Name: 'browser_sniffer.session' },
  },
  /**
   * Mount → first `PageLoaded`. The host shell's initial document-fetch
   * window; a child of the session span. Response spans nest under it until
   * the first page settles, after which it ends and {@link Sniffing.Page}
   * takes over.
   */
  InitialLoad: {
    Span: { Name: 'browser_sniffer.initial_load' },
  },
  /**
   * One settled page view: `PageLoaded` → next `PageLoaded`. A child of the
   * session span carrying {@link Sniffing.Attributes.UrlFull} and
   * {@link Sniffing.Attributes.PageContentId}. Response spans started while
   * it is open nest beneath it.
   */
  Page: {
    Span: { Name: 'browser_sniffer.page' },
  },
  /**
   * One sniffed response stream: `ResponseStart` → `ResponseFinished` /
   * `RequestError` / `Cancelled`. Child of the page span open at
   * `ResponseStart` (or the initial-load span before the first
   * `PageLoaded`). Accrues body bytes across `ResponseData` and ends with
   * the terminal {@link Sniffing.Attributes.Outcome}.
   */
  Response: {
    Span: { Name: 'browser_sniffer.response' },
  },
  /**
   * Host→web synthetic click. Recorded as a span *event* on the current
   * page span (or initial-load span) rather than its own span — a click
   * is an instantaneous act, not a timed interval.
   */
  Click: {
    Event: { Name: 'browser_sniffer.click' },
  },
} as const

export { Sniffing }
