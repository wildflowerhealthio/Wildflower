import { Schema } from 'effect'

/**
 * Wire schemas for the events the injected browser-sniffer posts to its
 * host and the control messages the host sends back. Each schema is a
 * tagged struct wrapped in `Schema.parseJson` so it round-trips through
 * `window.postMessage`'s string-only wire; the host decodes them via
 * `BrowserSnifferBridge`'s `BridgeTransport` and dispatches by `_tag`.
 *
 * Why JSON-flat (not nested envelopes): the sniffer is injected into
 * third-party pages and must use raw `window.ReactNativeWebView.postMessage`
 * without any module-loading. A flat tagged-struct wire format keeps the
 * sniffer trivial to author while still typed end-to-end at the host.
 *
 * The sniffer additionally posts `{"_tag":"__Ready"}` as its first
 * message (handled internally by `BridgeTransport`'s send-gating
 * Deferred). It is *not* declared here because it's a transport-level
 * control message, not a domain event consumers should observe.
 *
 * The `*Body` schemas (the inner `TaggedStruct`s before the
 * `parseJson` wrap) are exported separately so the injected sniffer
 * can type-import the JSON-stringifiable shape. The injected file
 * cannot import runtime schemas (everything resolves to nothing
 * inside the stringified function body), but type-only imports
 * survive the `toString()` path.
 *
 * Why `data` is a plain `Schema.String` (base64-encoded by convention)
 * and not `Schema.Uint8ArrayFromBase64`: the `BridgeTransport` runs
 * each inbound schema through `Schema.typeSchema`, which strips
 * transforms. A `Uint8ArrayFromBase64` field would leave the bridge
 * expecting an already-decoded `Uint8Array` after `JSON.parse`, which
 * the wire (a base64 string) cannot satisfy. Keeping `data: string`
 * lets the bridge decode round-trip cleanly; consumers that need
 * bytes apply `Schema.decode(Schema.Uint8ArrayFromBase64)` (or
 * `atob`) at their own boundary. See
 * `effect-messaging-core/docs/Bridge Schemas Reference.md` for the
 * project-wide write-up.
 *
 * `PageLoaded` is a notification only — it carries the page URL but
 * no body. The page DOM is delivered via the standard
 * `ResponseStart` / `ResponseData` / `ResponseFinished` triple with
 * a synthetic id (the page-content stream uses the same chunking
 * primitive as a real network response).
 *
 * `Cancelled` is the terminal acknowledgement the page posts in
 * response to a `CancelSnifferRequest` that arrives mid-stream. It
 * lets the host release per-id state without waiting for a Finished
 * that will never come.
 */

/** All correlation `id`s are non-empty — empty-string ids would
 * silently merge unrelated in-flight requests in the host's hash map. */
const SnifferRequestId = Schema.NonEmptyString.annotations({
  identifier: 'SnifferRequestId',
  description: 'Per-request correlation key used across the Response*/Cancelled triple.',
})

/**
 * Response headers as ordered `(name, value)` pairs. The web HTTP
 * spec allows the same header name to appear repeatedly (`Set-Cookie`
 * is the canonical case); a `Record<string, string>` collapses
 * repeats to a single value. The sniffer captures via
 * `Headers.entries()` which iterates each pair, so the wire stays
 * lossless if we use an array of tuples.
 */
const HeadersWire = Schema.Array(Schema.Tuple(Schema.String, Schema.String))

const ResponseStartMessageBody = Schema.TaggedStruct('ResponseStart', {
  id: SnifferRequestId,
  url: Schema.String,
  /**
   * The request verb this response was served for. A plain `Schema.String`
   * rather than a literal union: the wire is what the sniffer observed, and
   * a WebView intercept can pass any method through — an unrecognized value
   * is normalized to `'UNKNOWN'` at each consumer's own boundary, not
   * rejected at the bridge.
   */
  method: Schema.String,
  // Sniffer-observed status codes are integers; the schema is tightened
  // from bare `Schema.Number` so the bridge round-trip property test
  // stays JSON-safe — `Schema.Number` lets `Arbitrary` produce
  // `Infinity` / `NaN`, which `JSON.stringify` collapses to `null` and
  // round-trips lose.
  //
  // The accepted range `[0, 1000]` is wider than the standard HTTP
  // `[100, 599]` on purpose: WebView fetch intercepts can yield
  // `status: 0` for opaque CORS responses, aborted requests, and
  // pre-flight failures (browsers expose `0` rather than the
  // network-layer reason); the upper slack absorbs forward-compatible
  // custom codes that intermediaries occasionally inject. Tightening
  // further would drop real sniffer events on the floor.
  status: Schema.Int.pipe(Schema.between(0, 1000)),
  statusText: Schema.String,
  headers: HeadersWire,
})
const ResponseStartMessage = Schema.parseJson(ResponseStartMessageBody)

const ResponseDataMessageBody = Schema.TaggedStruct('ResponseData', {
  id: SnifferRequestId,
  /** Base64-encoded response bytes. See file header for why this is `String` and not `Uint8ArrayFromBase64`. */
  data: Schema.String,
})
const ResponseDataMessage = Schema.parseJson(ResponseDataMessageBody)

const ResponseFinishedMessageBody = Schema.TaggedStruct('ResponseFinished', {
  id: SnifferRequestId,
})
const ResponseFinishedMessage = Schema.parseJson(ResponseFinishedMessageBody)

const RequestErrorMessageBody = Schema.TaggedStruct('RequestError', {
  id: SnifferRequestId,
  url: Schema.String,
  message: Schema.String,
})
const RequestErrorMessage = Schema.parseJson(RequestErrorMessageBody)

/**
 * Posted by the page in response to a `CancelSnifferRequest` that
 * arrives while a tracked request is mid-stream. Acts as the
 * terminal observation for that id — host state can be released
 * without waiting for a `ResponseFinished` (which won't come). If
 * the cancel arrives after the natural terminal, the page silently
 * drops it.
 */
const CancelledMessageBody = Schema.TaggedStruct('Cancelled', {
  id: SnifferRequestId,
})
const CancelledMessage = Schema.parseJson(CancelledMessageBody)

/** Page-load notification — body intentionally absent; page content is
 * delivered via the `ResponseStart` / `ResponseData` /
 * `ResponseFinished` triple with the same id carried in
 * `pageContentId`. */
const PageLoadedMessageBody = Schema.TaggedStruct('PageLoaded', {
  url: Schema.String,
  /** Correlation id for the matching `Response*` stream that carries
   * the page's `documentElement.outerHTML`. Consumers that don't care
   * about the DOM body can ignore. */
  pageContentId: SnifferRequestId,
})
const PageLoadedMessage = Schema.parseJson(PageLoadedMessageBody)

/**
 * Early page-arrival notification — emitted once per document at
 * `DOMContentLoaded` (or immediately on injection into an already-parsed
 * document), so it precedes the settled `PageLoaded` and fires even for a page
 * that never settles (a resource that hangs `load`, a page that never goes
 * quiet). "Requested" names what a consumer may conclude: the awaited page has
 * been requested and its DOM has arrived — nothing about quiescence.
 *
 * Notification only: no `pageContentId` (the DOM snapshot stays tied to
 * settlement, streamed by `PageLoaded`'s Response triple), no body. The host
 * never decodes it — it forwards by `_tag` like the rest of the data plane.
 *
 * Wire: `{"_tag":"PageRequested","url":"https://…"}`
 */
const PageRequestedMessageBody = Schema.TaggedStruct('PageRequested', {
  url: Schema.String,
})
const PageRequestedMessage = Schema.parseJson(PageRequestedMessageBody)

const CancelSnifferRequestMessageBody = Schema.TaggedStruct('CancelSnifferRequest', {
  id: SnifferRequestId,
})
const CancelSnifferRequestMessage = Schema.parseJson(CancelSnifferRequestMessageBody)

/**
 * A synthetic click on the page: the sniffer runs
 * `document.querySelector(querySelector)?.click()`; a missing element
 * silently no-ops (typically the host issued the click before the target
 * rendered — retry by re-sending after the next `PageLoaded`).
 * `querySelector` is `NonEmptyString` so a typo or accidental empty value
 * fails at the bridge boundary. The `kind` literal discriminates this
 * variant inside {@link PageActionMessageBody}'s `action` union.
 */
const ClickAction = Schema.Struct({
  kind: Schema.Literal('Click'),
  querySelector: Schema.NonEmptyString,
})

/**
 * A synthetic form fill: the sniffer resolves
 * `document.querySelector(querySelector)` and, on a match, sets the
 * element's value through the framework-aware native value-setter +
 * `input`/`change` event dispatch (the standard controlled-input trick,
 * needed for SPA frameworks like Angular that ignore a bare `.value`
 * assignment). Like {@link ClickAction}, best-effort: a missing element
 * silently no-ops with no "no match" feedback path (the host retries by
 * re-sending after the next `PageLoaded`).
 *
 * `querySelector` is `NonEmptyString` so a typo or empty value fails at
 * the bridge boundary; `value` is a plain `String` so a deliberate
 * empty-string fill (clearing a field) is valid.
 *
 * NOTE (secrets): a scripted login interpolates a credential (e.g. a
 * password) into `value`, so this action can carry a secret across the
 * bridge. This is an accepted v1 deviation from the "never put secrets
 * in a bridge payload" guidance in `docs/Messaging/Wire Pinning How-To.md`;
 * a follow-up can gate it behind an out-of-band capability fetch
 * (the `AuthTokenIssued` pattern).
 */
const FillAction = Schema.Struct({
  kind: Schema.Literal('Fill'),
  querySelector: Schema.NonEmptyString,
  value: Schema.String,
})

/**
 * Host → Web: instruct the injected sniffer to perform a single in-page
 * action. One wire tag (`PageAction`) carries every scripted interaction;
 * the `action` field is a union discriminated by an inner `kind`, so a new
 * interaction kind (Scroll, WaitFor, Submit, …) becomes a new union variant
 * rather than a whole new bridge tag with its own demux + drift-guard
 * rollout. Best-effort with no acknowledgement, like the actions it wraps.
 *
 * The host (`browser-sniffer-tauri-rust`) never decodes this payload — it
 * only forwards it by `_tag` into the native webview on mobile — so there is
 * no serde mirror; the schema here is the sole validator. See
 * `docs/Messaging/Wire Pinning How-To.md`.
 *
 * Wire (Click): `{"_tag":"PageAction","action":{"kind":"Click","querySelector":"#go"}}`
 * Wire (Fill):  `{"_tag":"PageAction","action":{"kind":"Fill","querySelector":"#user","value":"alice"}}`
 */
const PageActionMessageBody = Schema.TaggedStruct('PageAction', {
  action: Schema.Union(ClickAction, FillAction),
})
const PageActionMessage = Schema.parseJson(PageActionMessageBody)

export {
  ResponseStartMessage,
  ResponseStartMessageBody,
  ResponseDataMessage,
  ResponseDataMessageBody,
  ResponseFinishedMessage,
  ResponseFinishedMessageBody,
  RequestErrorMessage,
  RequestErrorMessageBody,
  CancelledMessage,
  CancelledMessageBody,
  PageLoadedMessage,
  PageLoadedMessageBody,
  PageRequestedMessage,
  PageRequestedMessageBody,
  CancelSnifferRequestMessage,
  CancelSnifferRequestMessageBody,
  PageActionMessage,
  PageActionMessageBody,
  SnifferRequestId,
  HeadersWire,
}
