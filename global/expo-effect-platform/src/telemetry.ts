/**
 * Central catalog of OpenTelemetry span names and attribute keys for the
 * Expo native HTTP server adapter (`internal/httpServer.ts`). Mirrors the
 * `collector-fundamentals/telemetry` and `browser-sniffer-core/telemetry`
 * catalogs so the naming philosophy lives in one place.
 *
 * Most of this is standard HTTP-server instrumentation, so span and
 * attribute names follow OpenTelemetry semantic conventions:
 *
 *  - {@link Request} is a SERVER span named by HTTP method. The semconv
 *    server-span name is `{method} {route}`, but there is no route at the
 *    native adapter layer (routing happens later, inside the `@effect/platform`
 *    router), so the name is just the method — a low-cardinality value —
 *    and the (high-cardinality) path rides the `url.path` attribute.
 *  - Attribute keys use the stable HTTP / URL / network semconv keys
 *    (`http.request.method`, `http.response.status_code`, `url.path`, …).
 *
 * Bridge-specific seams with no semconv equivalent — the JS→native
 * response write and how the native payload carried the request body —
 * are namespaced under `expo_http.*`.
 */

/**
 * Attribute keys. OTel HTTP / URL / network semantic conventions where
 * one exists; `expo_http.*` for adapter-specific detail the conventions
 * don't cover.
 */
const Attributes = {
  /** HTTP request method (semconv). */
  HttpRequestMethod: 'http.request.method',
  /** HTTP response status code (semconv). */
  HttpResponseStatusCode: 'http.response.status_code',
  /** Size in bytes of the response body written over the bridge (semconv). */
  HttpResponseBodySize: 'http.response.body.size',
  /** Request URL path, without the query (semconv). */
  UrlPath: 'url.path',
  /** Request URL query string, without the leading `?` (semconv). */
  UrlQuery: 'url.query',
  /** Address of the request's peer / client (semconv). */
  ClientAddress: 'client.address',
  /**
   * How the native `onHttpRequest` payload carried the request body —
   * `inline` (UTF-8 string), `base64`, `file` (a `file://` URI), or
   * `empty`. No semconv key covers the bridge's body transport.
   */
  BodySource: 'expo_http.body.source',
  /** Bridge encoding of the response body: `utf8` or `base64`. */
  ResponseEncoding: 'expo_http.response.encoding',
  /** Set to `file` when the response streams a native file. */
  ResponseKind: 'expo_http.response.kind',
} as const

/**
 * The whole JS-visible request lifetime: native `onHttpRequest` event →
 * response write-back. A SERVER-kind span that continues the client's W3C
 * trace when the request carries a `traceparent` header (otherwise a new
 * root). The routed handler's own spans (e.g. `fhir.Update`) nest beneath
 * it, so the gap between this span's start and the first handler span is
 * the middleware / routing cost.
 */
const Request = {
  Span: {
    /** OTel server span name: the HTTP method (no route at this layer). */
    name: (method: string): string => method,
    /** OTel span kind for an inbound server request. */
    Kind: 'server',
  },
} as const

/** Decoding the request body off the native payload. */
const BodyRead = {
  Span: { Name: 'expo_http.body_read' },
} as const

/**
 * The JS→native bridge write of the response (`respondToRequest` /
 * `respondToRequestWithFile`). The adapter's prime latency suspect:
 * everything before it is JS, and the native server's socket flush
 * happens after it returns.
 */
const Respond = {
  Span: { Name: 'expo_http.respond' },
} as const

/**
 * The `@effect/platform` HttpApi pass over a request: app-level middleware,
 * route match, request schema decode, the routed handler (whose own `fhir.*`
 * / LiveStore spans nest beneath), and response schema encode. A sibling of
 * {@link HandleResponse} under {@link Request}. HttpApi does the decode and
 * encode internally, so this adapter can't span them directly — but
 * subtracting the handler's own spans from this one bounds the
 * decode + encode + middleware cost.
 */
const App = {
  Span: { Name: 'expo_http.app' },
} as const

/**
 * Turning the handler's `HttpServerResponse` into bridge arguments: cookie /
 * header expansion, body-tag dispatch, and — for binary / stream bodies —
 * the base64 encode (see {@link EncodeBase64}), up to the {@link Respond}
 * write. The JS work between HttpApi and the native bridge.
 */
const HandleResponse = {
  Span: { Name: 'expo_http.handle_response' },
} as const

/**
 * Base64-encoding a binary or streamed response body before the bridge
 * write — CPU-bound and scaling with body size, so it carries
 * {@link Attributes.HttpResponseBodySize} (the decoded byte count).
 */
const EncodeBase64 = {
  Span: { Name: 'expo_http.encode_base64' },
} as const

export { App, Attributes, BodyRead, EncodeBase64, HandleResponse, Request, Respond }
