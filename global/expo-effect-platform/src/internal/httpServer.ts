import {
  Cookies,
  Headers,
  HttpApp as App,
  HttpServer as Server,
  HttpServerError as Error,
  HttpServerRequest as ServerRequest,
  Multipart,
  UrlParams,
} from '@effect/platform'
import type {
  FileSystem,
  HttpIncomingMessage as IncomingMessage,
  HttpServerResponse as ServerResponse,
  Path,
  Socket,
  HttpMethod,
  HttpMiddleware,
} from '@effect/platform'
import {
  Cause,
  Duration,
  Effect,
  FiberSet,
  Inspectable,
  Layer,
  Option,
  Ref,
  Stream,
  Tracer,
} from 'effect'
import type { Record as RecordNS, Scope } from 'effect'
import type { OnHttpRequestPayload, ServerOptions } from '../ExpoEffectPlatform.types.ts'
import NativeModule from '../ExpoEffectPlatformModule.ts'
import * as Telemetry from '../telemetry.ts'

/**
 * Parsed W3C `traceparent` fields, narrowed to what {@link Tracer.externalSpan}
 * needs to continue the client's distributed trace on the server span.
 */
interface TraceParent {
  readonly traceId: string
  readonly spanId: string
  readonly sampled: boolean
}

/**
 * Parse a request's W3C `traceparent` header so the {@link Telemetry.Request}
 * server span continues the client's trace instead of starting a fresh root.
 * Returns `undefined` for a missing or malformed header (the request then
 * roots its own trace). Validates per the W3C Trace Context spec: four
 * `-`-separated fields, a non-`ff` version, a 32-hex non-zero trace id, a
 * 16-hex non-zero span id, a 2-hex flags byte whose bit 0 is the sampled flag.
 */
const parseTraceParent = (header: string | undefined): TraceParent | undefined => {
  if (header === undefined) return undefined
  const parts = header.trim().split('-')
  if (parts.length !== 4) return undefined
  const [version, traceId, spanId, flags] = parts
  if (version === undefined || !/^[0-9a-f]{2}$/.test(version) || version === 'ff') return undefined
  if (traceId === undefined || !/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId)) {
    return undefined
  }
  if (spanId === undefined || !/^[0-9a-f]{16}$/.test(spanId) || /^0+$/.test(spanId))
    return undefined
  if (flags === undefined || !/^[0-9a-f]{2}$/.test(flags)) return undefined
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 1 }
}

// ---------------------------------------------------------------------------
// ServerRequestImpl
// ---------------------------------------------------------------------------

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const ServerRequestTypeId: ServerRequest.TypeId = Symbol.for(
  '@effect/platform/HttpServerRequest'
) as ServerRequest.TypeId

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const IncomingMessageTypeId: IncomingMessage.TypeId = Symbol.for(
  '@effect/platform/HttpIncomingMessage'
) as IncomingMessage.TypeId

const flattenHeaders = (input: Record<string, ReadonlyArray<string>>): Headers.Headers => {
  const out: Record<string, string | ReadonlyArray<string>> = {}
  for (const [k, values] of Object.entries(input)) {
    if (values.length === 0) continue
    if (values.length === 1) {
      out[k] = values[0]!
    } else {
      out[k] = values
    }
  }
  return Headers.fromInput(out)
}

const decodeBase64 = (b64: string): Uint8Array => {
  const bin = globalThis.atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const encodeBase64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return globalThis.btoa(bin)
}

/**
 * {@link encodeBase64} timed as a span — base64 of a large response body is
 * CPU-bound and scales with size, so it's a per-request latency suspect of
 * its own. Carries the decoded byte count as the response body size.
 */
const encodeBase64Spanned = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.sync(() => encodeBase64(bytes)).pipe(
    Effect.withSpan(Telemetry.EncodeBase64.Span.Name, {
      attributes: { [Telemetry.Attributes.HttpResponseBodySize]: bytes.length },
    })
  )

class ServerRequestImpl extends Inspectable.Class implements ServerRequest.HttpServerRequest {
  readonly [ServerRequest.TypeId]: ServerRequest.TypeId
  readonly [IncomingMessageTypeId]: IncomingMessage.TypeId

  constructor(
    readonly source: OnHttpRequestPayload,
    readonly url: string,
    public headersOverride?: Headers.Headers,
    private remoteAddressOverride?: string
  ) {
    super()
    this[ServerRequestTypeId] = ServerRequestTypeId
    this[IncomingMessageTypeId] = IncomingMessageTypeId
  }

  get requestId(): string {
    return this.source.requestId
  }

  toJSON(): unknown {
    return {
      _id: '@effect/platform/HttpServerRequest',
      method: this.method,
      url: this.originalUrl,
    }
  }

  modify(options: {
    readonly url?: string | undefined
    readonly headers?: Headers.Headers | undefined
    readonly remoteAddress?: string | undefined
  }): ServerRequest.HttpServerRequest {
    return new ServerRequestImpl(
      this.source,
      options.url ?? this.url,
      options.headers ?? this.headersOverride,
      options.remoteAddress ?? this.remoteAddressOverride
    )
  }

  get method(): HttpMethod.HttpMethod {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return this.source.method.toUpperCase() as HttpMethod.HttpMethod
  }

  get originalUrl(): string {
    return this.source.path
  }

  get remoteAddress(): Option.Option<string> {
    const fromOverride = Option.fromNullable(this.remoteAddressOverride).pipe(
      Option.filter((s) => s.trim().length > 0)
    )
    const fromSource = Option.fromNullable(this.source.ip).pipe(
      Option.filter((s) => s.trim().length > 0)
    )
    return Option.orElse(fromOverride, () => fromSource)
  }

  get headers(): Headers.Headers {
    this.headersOverride ??= flattenHeaders(this.source.headers)
    return this.headersOverride
  }

  private cachedCookies: RecordNS.ReadonlyRecord<string, string> | undefined
  get cookies(): RecordNS.ReadonlyRecord<string, string> {
    if (this.cachedCookies) {
      return this.cachedCookies
    }
    const cookieValues = this.source.headers['cookie'] ?? this.source.headers['Cookie'] ?? []
    return (this.cachedCookies = Cookies.parseHeader(cookieValues.join('; ')))
  }

  // -- Body access --

  private bytesEffect: Effect.Effect<Uint8Array, Error.RequestError> | undefined
  private get bytes(): Effect.Effect<Uint8Array, Error.RequestError> {
    if (this.bytesEffect) return this.bytesEffect
    let source: Effect.Effect<Uint8Array, Error.RequestError>
    if (this.source.body != null) {
      source = Effect.succeed(new TextEncoder().encode(this.source.body))
    } else if (this.source.bodyBase64 != null) {
      const b64 = this.source.bodyBase64
      source = Effect.try({
        try: () => decodeBase64(b64),
        catch: (cause) =>
          new Error.RequestError({
            request: this,
            reason: 'Decode',
            cause,
          }),
      })
    } else if (this.source.bodyFilePath != null) {
      const filePath = this.source.bodyFilePath
      source = Effect.tryPromise({
        try: () =>
          fetch(`file://${encodeURI(filePath)}`)
            .then((r) => r.arrayBuffer())
            .then((ab) => new Uint8Array(ab)),
        catch: (cause) =>
          new Error.RequestError({
            request: this,
            reason: 'Decode',
            cause,
          }),
      })
    } else {
      source = Effect.succeed(new Uint8Array(0))
    }
    const bodySource =
      this.source.body != null
        ? 'inline'
        : this.source.bodyBase64 != null
          ? 'base64'
          : this.source.bodyFilePath != null
            ? 'file'
            : 'empty'
    this.bytesEffect = Effect.runSync(
      Effect.cached(
        source.pipe(
          Effect.withSpan(Telemetry.BodyRead.Span.Name, {
            attributes: { [Telemetry.Attributes.BodySource]: bodySource },
          })
        )
      )
    )
    return this.bytesEffect
  }

  get text(): Effect.Effect<string, Error.RequestError> {
    return this.bytes.pipe(Effect.map((b) => new TextDecoder().decode(b)))
  }

  get json(): Effect.Effect<unknown, Error.RequestError> {
    return Effect.tryMap(this.text, {
      try: (_) => JSON.parse(_) as unknown,
      catch: (cause) =>
        new Error.RequestError({
          request: this,
          reason: 'Decode',
          cause,
        }),
    })
  }

  get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, Error.RequestError> {
    return this.text.pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => UrlParams.fromInput(new URLSearchParams(text)),
          catch: (cause) =>
            new Error.RequestError({
              request: this,
              reason: 'Decode',
              cause,
            }),
        })
      )
    )
  }

  get arrayBuffer(): Effect.Effect<ArrayBuffer, Error.RequestError> {
    return this.bytes.pipe(
      Effect.map((b) => {
        const copy = new Uint8Array(b)
        return copy.buffer
      })
    )
  }

  get stream(): Stream.Stream<Uint8Array, Error.RequestError> {
    if (this.source.bodyFilePath != null) {
      // Read the file body as chunks via fetch().body to avoid buffering the
      // entire payload into JS memory at once. Falls back to a single chunk
      // when ReadableStream is unavailable.
      return Stream.fromEffect(
        Effect.tryPromise({
          try: () => fetch(`file://${encodeURI(this.source.bodyFilePath ?? '')}`),
          catch: (cause) => new Error.RequestError({ request: this, reason: 'Decode', cause }),
        })
      ).pipe(
        Stream.flatMap((res): Stream.Stream<Uint8Array, Error.RequestError> => {
          if (res.body == null) {
            return Stream.fromEffect(
              Effect.tryPromise({
                try: () => res.arrayBuffer().then((ab) => new Uint8Array(ab)),
                catch: (cause) =>
                  new Error.RequestError({ request: this, reason: 'Decode', cause }),
              })
            )
          }
          return Stream.fromReadableStream(
            () => res.body!,
            (cause) => new Error.RequestError({ request: this, reason: 'Decode', cause })
          )
        })
      )
    }
    return Stream.fromEffect(this.bytes)
  }

  get multipart(): Effect.Effect<
    Multipart.Persisted,
    Multipart.MultipartError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return Effect.fail(
      new Multipart.MultipartError({
        reason: 'InternalError',
        cause: 'Multipart parsing is not supported in expo-effect-platform v1',
      })
    )
  }

  get multipartStream(): Stream.Stream<Multipart.Part, Multipart.MultipartError> {
    return Stream.fail(
      new Multipart.MultipartError({
        reason: 'InternalError',
        cause: 'Multipart parsing is not supported in expo-effect-platform v1',
      })
    )
  }

  get upgrade(): Effect.Effect<Socket.Socket, Error.RequestError> {
    return Effect.fail(
      new Error.RequestError({
        request: this,
        reason: 'Decode',
        description: 'WebSocket upgrade is not supported in expo-effect-platform v1',
      })
    )
  }
}

// ---------------------------------------------------------------------------
// handleResponse
// ---------------------------------------------------------------------------

/** Sentinel marker for file-backed responses produced by ExpoHttpPlatform */
interface ExpoFileBody {
  readonly expoFilePath: string
  readonly start?: number
  readonly end?: number
}

const isExpoFileBody = (body: unknown): body is ExpoFileBody =>
  typeof body === 'object' &&
  body !== null &&
  'expoFilePath' in body &&
  typeof body.expoFilePath === 'string'

/**
 * True when a media type carries text content that round-trips losslessly as a
 * UTF-8 JS string. `HttpServerResponse.text()` and `unsafeJson()` produce
 * `Uint8Array` bodies (text → encoded bytes) but should be sent over the
 * native bridge as `utf8` to avoid the base64 round-trip; `uint8Array()` with
 * an octet-stream type stays binary.
 */
const isTextContentType = (contentType: string | undefined): boolean => {
  if (!contentType) return false
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mediaType.startsWith('text/')) return true
  if (/\+(json|xml|text)$/.test(mediaType)) return true
  return (
    mediaType === 'application/json' ||
    mediaType === 'application/javascript' ||
    mediaType === 'application/xml' ||
    mediaType === 'application/x-www-form-urlencoded'
  )
}

const expandHeaders = (
  responseHeaders: Headers.Headers,
  setCookies: ReadonlyArray<string>
): Record<string, ReadonlyArray<string>> => {
  const out: Record<string, Array<string>> = {}
  for (const [k, v] of Object.entries(responseHeaders)) {
    out[k] = [v]
  }
  if (setCookies.length > 0) {
    out['set-cookie'] = setCookies.slice()
  }
  return out
}

/**
 * Write a response back across the JS→native bridge, timed as a
 * {@link Telemetry.Respond} span and a console line. This promise is the
 * adapter's prime latency suspect: everything before it is JS, and the
 * native server's socket flush happens after it returns — so a slow
 * `respond` localises the cost to the bridge / native server.
 */
const respond = (
  request: ServerRequestImpl,
  response: ServerResponse.HttpServerResponse,
  headers: Record<string, ReadonlyArray<string>>,
  body: string,
  encoding: 'utf8' | 'base64'
): Effect.Effect<void, Error.ResponseError> =>
  Effect.tryPromise({
    try: () =>
      NativeModule.respondToRequest(request.requestId, response.status, headers, body, encoding),
    catch: (cause) => new Error.ResponseError({ request, response, reason: 'Decode', cause }),
  }).pipe(
    Effect.withSpan(Telemetry.Respond.Span.Name, {
      attributes: {
        [Telemetry.Attributes.HttpResponseStatusCode]: response.status,
        [Telemetry.Attributes.ResponseEncoding]: encoding,
        [Telemetry.Attributes.HttpResponseBodySize]: body.length,
      },
    }),
    Effect.timed,
    Effect.tap(([elapsed]) =>
      Effect.logInfo(
        `[expo_http] respond ${response.status} ${encoding} ${body.length}b in ${Duration.toMillis(elapsed)}ms`
      )
    ),
    Effect.asVoid,
    Effect.tapErrorCause((cause) =>
      Effect.logError(
        `ExpoHttpServer: native respondToRequest rejected (${request.method} ${request.url}, status ${response.status}, ${body.length} ${encoding} chars)`,
        cause
      )
    )
  )

/** File-backed variant of {@link respond} (native streams the file). */
const respondWithFile = (
  request: ServerRequestImpl,
  response: ServerResponse.HttpServerResponse,
  headers: Record<string, ReadonlyArray<string>>,
  filePath: string,
  start: number | null,
  end: number | null
): Effect.Effect<void, Error.ResponseError> =>
  Effect.tryPromise({
    try: () =>
      NativeModule.respondToRequestWithFile(
        request.requestId,
        response.status,
        headers,
        filePath,
        start,
        end
      ),
    catch: (cause) => new Error.ResponseError({ request, response, reason: 'Decode', cause }),
  }).pipe(
    Effect.withSpan(Telemetry.Respond.Span.Name, {
      attributes: {
        [Telemetry.Attributes.HttpResponseStatusCode]: response.status,
        [Telemetry.Attributes.ResponseKind]: 'file',
      },
    }),
    Effect.timed,
    Effect.tap(([elapsed]) =>
      Effect.logInfo(
        `[expo_http] respond ${response.status} file in ${Duration.toMillis(elapsed)}ms`
      )
    ),
    Effect.asVoid,
    Effect.tapErrorCause((cause) =>
      Effect.logError(
        `ExpoHttpServer: native respondToRequestWithFile rejected (${request.method} ${request.url}, status ${response.status}, file ${filePath})`,
        cause
      )
    )
  )

const handleResponse = (
  request: ServerRequest.HttpServerRequest,
  response: ServerResponse.HttpServerResponse
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (!(request instanceof ServerRequestImpl)) {
      yield* Effect.die(
        new Error.RequestError({
          request,
          reason: 'Decode',
          description: 'Unexpected request implementation — expected ServerRequestImpl',
        })
      )
      return
    }
    // Record the status on the server (request) span — the current span here,
    // since the inner handler spans have already closed by response time.
    yield* Effect.annotateCurrentSpan(Telemetry.Attributes.HttpResponseStatusCode, response.status)

    let setCookies: ReadonlyArray<string> = []
    if (!Cookies.isEmpty(response.cookies)) {
      setCookies = Cookies.toSetCookieHeaders(response.cookies)
    }
    const headers = expandHeaders(response.headers, setCookies)

    // Summarise what status is about to cross the bridge. A 5xx here means the
    // served app failed (see `loggedApp` in serve()) or toHandled derived an
    // error response; logged at WARNING so it stands out in on-device logs.
    const relayLog = response.status >= 500 ? Effect.logWarning : Effect.logDebug
    yield* relayLog(
      `ExpoHttpServer: relaying ${response.status} (${request.method} ${request.url}, body ${response.body._tag})`
    )

    if (request.method === 'HEAD') {
      yield* respond(request, response, headers, '', 'utf8')
      return
    }

    response = App.unsafeEjectStreamScope(response)
    const body = response.body

    switch (body._tag) {
      case 'Empty': {
        yield* respond(request, response, headers, '', 'utf8')
        break
      }
      case 'Raw': {
        const rawBody = body.body
        if (isExpoFileBody(rawBody)) {
          yield* respondWithFile(
            request,
            response,
            headers,
            rawBody.expoFilePath,
            rawBody.start ?? null,
            rawBody.end ?? null
          )
        } else {
          let rawText = ''
          if (typeof rawBody === 'string') {
            rawText = rawBody
          } else if (rawBody != null) {
            rawText = JSON.stringify(rawBody)
          }
          yield* respond(request, response, headers, rawText, 'utf8')
        }
        break
      }
      case 'Uint8Array': {
        if (isTextContentType(body.contentType)) {
          const text = new TextDecoder('utf-8').decode(body.body)
          yield* respond(request, response, headers, text, 'utf8')
        } else {
          const b64 = yield* encodeBase64Spanned(body.body)
          yield* respond(request, response, headers, b64, 'base64')
        }
        break
      }
      case 'FormData': {
        yield* respond(
          request,
          response,
          headers,
          'FormData responses are not supported in expo-effect-platform v1',
          'utf8'
        )
        break
      }
      case 'Stream': {
        const chunks: Array<Uint8Array> = []
        yield* Stream.runForEach(body.stream, (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk)
          })
        )
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0)
        const combined = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          combined.set(chunk, offset)
          offset += chunk.length
        }
        const b64 = yield* encodeBase64Spanned(combined)
        yield* respond(request, response, headers, b64, 'base64')
        break
      }
    }
  }).pipe(Effect.withSpan(Telemetry.HandleResponse.Span.Name))

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = (
  port: number,
  options?: ServerOptions
): Effect.Effect<Server.HttpServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      // `Effect.promise` turns a rejection into a *defect* (the layer's error
      // channel is `never`, so it can't be widened) — without this span + log
      // a failed native bind would die silently. `tapErrorCause` runs after the
      // span closes, matching `respond`'s pattern below.
      Effect.promise(() => NativeModule.startServer(port, options)).pipe(
        Effect.withSpan(Telemetry.Server.Start.Span.Name, {
          attributes: { [Telemetry.Server.Attributes.Port]: port },
        }),
        Effect.tapErrorCause((cause) =>
          Effect.logError(`ExpoHttpServer: native startServer rejected (port ${port})`, cause)
        )
      ),
      // `stopServer`'s argument is FlyingFox's `server.stop(timeout:)` grace
      // window for in-flight requests. The default 5s matches a vanilla HTTP
      // server but is the wrong shape for short-budget hosts (iOS background
      // expiration); consumers can override via `options.stopTimeoutSeconds`.
      () =>
        Effect.promise(() => NativeModule.stopServer(options?.stopTimeoutSeconds ?? 5)).pipe(
          Effect.withSpan(Telemetry.Server.Stop.Span.Name, {
            attributes: { [Telemetry.Server.Attributes.Port]: port },
          }),
          Effect.tapErrorCause((cause) =>
            Effect.logError(`ExpoHttpServer: native stopServer rejected (port ${port})`, cause)
          )
        )
    )

    const hostname = options?.hostname ?? '127.0.0.1'

    // Track whether serve() has already been invoked on this server. The
    // HttpServer contract is one-serve-per-server; a second call would attach
    // a second listener and dispatch every request twice. Fail fast on misuse.
    const servedRef = yield* Ref.make(false)

    return Server.make({
      address: { _tag: 'TcpAddress', hostname, port },
      serve(
        httpApp: App.Default<unknown>,
        middleware?: HttpMiddleware.HttpMiddleware
      ): Effect.Effect<void, never, Scope.Scope> {
        return Effect.gen(function* () {
          const alreadyServed = yield* Ref.getAndSet(servedRef, true)
          if (alreadyServed) {
            yield* Effect.die(
              new globalThis.Error(
                'ExpoHttpServer: serve() called more than once on the same server. ' +
                  'HttpServer.serve() is single-shot — start a new server instead.'
              )
            )
          }
          const runFork = yield* FiberSet.makeRuntime<never>()
          // Span the whole HttpApi pass (middleware + route + schema decode +
          // handler + schema encode) so the trace shows "time inside HttpApi"
          // as one span. The routed `fhir.*` / LiveStore spans nest beneath
          // it; the remainder is the decode/encode/middleware HttpApi does
          // internally, which this adapter can't span directly.
          //
          // `tapErrorCause` logs the served app failing *before* toHandled
          // collapses the cause into an opaque 500/empty response — that's the
          // signal that distinguishes "the FHIR handler died" (this log fires)
          // from "the bridge failed to relay a good response" (the native
          // respond* rejection logs instead). Interrupts are normal teardown,
          // so they're filtered out.
          const loggedApp = httpApp.pipe(
            Effect.withSpan(Telemetry.App.Span.Name),
            Effect.tapErrorCause((cause) =>
              Cause.isInterruptedOnly(cause)
                ? Effect.void
                : Effect.flatMap(ServerRequest.HttpServerRequest, (req) =>
                    Effect.logError(
                      `ExpoHttpServer: served app failed before response conversion (${req.method} ${req.url}); relaying a derived error response`,
                      cause
                    )
                  )
            )
          )
          const app = App.toHandled(loggedApp, handleResponse, middleware)

          const subscription = NativeModule.addListener(
            'onHttpRequest',
            (payload: OnHttpRequestPayload) => {
              const request = new ServerRequestImpl(payload, payload.path)
              // Wall clock from the moment the native event lands in JS to
              // the moment the response write-back settles — the
              // JS-visible request time. Compare against the client's own
              // request duration: if this is small but the client sees
              // seconds, the cost is in the native receive/socket flush.
              const receivedAtMs = Date.now()
              // `originalUrl` carries the query; the server-span semconv keeps
              // the (high-cardinality) query off the path attribute.
              const queryIndex = request.originalUrl.indexOf('?')
              const urlPath =
                queryIndex === -1 ? request.originalUrl : request.originalUrl.slice(0, queryIndex)
              const urlQuery =
                queryIndex === -1 ? undefined : request.originalUrl.slice(queryIndex + 1)
              const clientAddress = Option.getOrUndefined(request.remoteAddress)
              const attributes = {
                [Telemetry.Attributes.HttpRequestMethod]: request.method,
                [Telemetry.Attributes.UrlPath]: urlPath,
                ...(urlQuery === undefined ? {} : { [Telemetry.Attributes.UrlQuery]: urlQuery }),
                ...(clientAddress === undefined
                  ? {}
                  : { [Telemetry.Attributes.ClientAddress]: clientAddress }),
              }
              // Continue the client's distributed trace when it forwarded a
              // `traceparent`; otherwise this request roots its own trace.
              // Either way the routed handler spans (`fhir.Update`, …) nest
              // under this server span rather than the long-lived daemon scope.
              const traceParent = parseTraceParent(request.headers['traceparent'])
              const lineage =
                traceParent === undefined
                  ? { root: true as const }
                  : {
                      parent: Tracer.externalSpan({
                        traceId: traceParent.traceId,
                        spanId: traceParent.spanId,
                        sampled: traceParent.sampled,
                      }),
                    }
              runFork(
                // `suspend` defers to fiber-run time, so `scheduledAtMs` is when
                // the forked fiber actually starts executing. The delta from
                // `receivedAtMs` is fork-scheduling latency — the one segment the
                // spans below can't see, because their clocks only start once the
                // fiber runs. On RN's single JS thread a saturated runtime (e.g. a
                // LiveStore commit storm) shows up here as a large `scheduled in`.
                Effect.suspend(() => {
                  const scheduledAtMs = Date.now()
                  return Effect.provideService(
                    app,
                    ServerRequest.HttpServerRequest,
                    request
                  ).pipe(
                    Effect.withSpan(Telemetry.Request.Span.name(request.method), {
                      kind: Telemetry.Request.Span.Kind,
                      ...lineage,
                      attributes,
                    }),
                    Effect.onExit(() =>
                      Effect.logInfo(
                        `[expo_http] ${request.method} ${request.originalUrl} scheduled in ${scheduledAtMs - receivedAtMs}ms, handled in ${Date.now() - receivedAtMs}ms`
                      )
                    )
                  )
                })
              )
            }
          )

          yield* Effect.addFinalizer(() => Effect.sync(() => subscription.remove()))
        })
      },
    })
  })

// ---------------------------------------------------------------------------
// layer
// ---------------------------------------------------------------------------

const layer = (options: { port: number } & ServerOptions): Layer.Layer<Server.HttpServer> =>
  Layer.scoped(Server.HttpServer, make(options.port, options))

export { make, layer, ServerRequestImpl }
export type { ExpoFileBody }
