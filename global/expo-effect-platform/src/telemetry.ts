/**
 * Central catalog of OpenTelemetry span names and attribute keys for the
 * Expo native HTTP server adapter (`internal/httpServer.ts`). Mirrors the
 * `collector-fundamentals/telemetry` and `browser-sniffer-core/telemetry`
 * catalogs so the naming philosophy lives in one place.
 *
 * Most of this is standard HTTP-server instrumentation, so span and
 * attribute names follow OpenTelemetry semantic conventions:
 *
 *  - {@link Request} is an INTERNAL bridge-envelope span (`expo_http.request`),
 *    not a `http.server` span. `@effect/platform`'s tracer middleware (always
 *    applied by `App.toHandled`) opens its own `http.server {method}` server
 *    span nested directly beneath it, so the envelope avoids competing as a
 *    second server span; the (high-cardinality) path rides the `url.path`
 *    attribute on the platform's span.
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
 * response write-back. An INTERNAL-kind bridge-envelope span named
 * `expo_http.request`. It deliberately is NOT the `http.server` server span:
 * `@effect/platform`'s tracer middleware (always applied by `App.toHandled`)
 * opens its own `http.server {method}` server span nested directly beneath
 * this one. The envelope continues the client's W3C trace when the request
 * carries a `traceparent` header (otherwise a new root), so both spans share
 * the same client-trace parent. The routed handler's own spans (e.g.
 * `fhir.Update`) nest beneath, so the gap between this span's start and the
 * first handler span is the middleware / routing cost.
 */
const Request = {
  Span: {
    /** Bridge-envelope span name — not the semconv `http.server` span. */
    Name: 'expo_http.request',
    /** Internal kind: the platform tracer owns the nested `http.server` span. */
    Kind: 'internal',
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

/**
 * The native server lifecycle behind the `HttpServer` layer: `startServer`
 * (the `acquireRelease` acquire) and `stopServer` (its release). A rejection
 * of either native promise surfaces as a *defect* — the layer's error channel
 * is `never`, so the adapter can't widen it — which is why both carry a span
 * and a log: the failure is otherwise invisible until the daemon dies.
 * `expo_http.*` namespaced; `server.port` is the OTel network semconv key.
 */
const Server = {
  Attributes: {
    /** TCP port the native server was asked to bind (OTel semconv). */
    Port: 'server.port',
  },
  /** `NativeModule.startServer` — bind the listener. */
  Start: { Span: { Name: 'expo_http.server.start' } },
  /** `NativeModule.stopServer` — drain in-flight requests, release the port. */
  Stop: { Span: { Name: 'expo_http.server.stop' } },
} as const

/**
 * The Expo-backed `FileSystem.FileSystem` operations
 * (`internal/file-system/*`). There is no stable OpenTelemetry file-system
 * semconv, so span names are namespaced under `expo_fs.*` (mirroring
 * `expo_http.*`); the OTel `error.type` key carries the failing
 * `SystemError.reason` on the failure branch, and `expo_fs.path` the target
 * path. Each implemented op is one span; the shared `Paths.info` probe nests
 * beneath it as {@link FileSystem.Inspect}.
 */
const FileSystem = {
  Attributes: {
    /** Absolute path the operation targeted (device-local). */
    Path: 'expo_fs.path',
    /**
     * `SystemError.reason` of a failed op (`NotFound`, `PermissionDenied`,
     * `BadResource`, `Unknown`, …), recorded on the failure branch. OTel
     * semconv key.
     */
    ErrorType: 'error.type',
  },
  /** `Paths.info` existence/kind probe shared by `access`/`stat`/`readFile`/… */
  Inspect: { Span: { Name: 'expo_fs.inspect' } },
  /** `access` — existence check (also backs the derived `exists`). */
  Access: { Span: { Name: 'expo_fs.access' } },
  /** `stat` — file / directory metadata. */
  Stat: { Span: { Name: 'expo_fs.stat' } },
  /** `readFile` — read a whole file into bytes. */
  ReadFile: { Span: { Name: 'expo_fs.read_file' } },
  /** `writeFile` — create-or-overwrite a file. */
  WriteFile: { Span: { Name: 'expo_fs.write_file' } },
  /** `makeDirectory` — create a directory (optionally recursive). */
  MakeDirectory: { Span: { Name: 'expo_fs.make_directory' } },
  /** `remove` — delete a file or directory. */
  Remove: { Span: { Name: 'expo_fs.remove' } },
} as const

/**
 * `HttpPlatform.fileResponse` / `fileWebResponse`
 * (`internal/httpPlatform.ts`): turning a file path into an
 * `HttpServerResponse` by reading size + mtime via `expo-file-system`'s
 * *synchronous* `File` accessors. Those accessors throw on native failure, so
 * the span's failure branch records `error.type`. `expo_http.*` namespaced.
 */
const FileResponse = {
  Attributes: {
    /** Path of the file being served. */
    Path: 'expo_fs.path',
    /** Byte length advertised as `Content-Length` (OTel HTTP semconv). */
    BodySize: 'http.response.body.size',
    /** `SystemError.reason` recorded on the failure branch (OTel semconv). */
    ErrorType: 'error.type',
  },
  /** Building a file-backed response (`fileResponse`). */
  Span: { Name: 'expo_http.file_response' },
  /** The unsupported `fileWebResponse` path (returns 501). */
  Web: { Span: { Name: 'expo_http.file_web_response' } },
} as const

export {
  App,
  Attributes,
  BodyRead,
  EncodeBase64,
  FileResponse,
  FileSystem,
  HandleResponse,
  Request,
  Respond,
  Server,
}
