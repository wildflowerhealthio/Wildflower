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
import { Effect, FiberSet, Inspectable, Layer, Option, Ref, Stream } from 'effect'
import type { Record as RecordNS, Scope } from 'effect'
import type { OnHttpRequestPayload, ServerOptions } from '../ExpoEffectPlatform.types.ts'
import NativeModule from '../ExpoEffectPlatformModule.ts'

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
    this.bytesEffect = Effect.runSync(Effect.cached(source))
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
  readonly __expoFilePath: string
  readonly start?: number
  readonly end?: number
}

const isExpoFileBody = (body: unknown): body is ExpoFileBody =>
  typeof body === 'object' &&
  body !== null &&
  '__expoFilePath' in body &&
  typeof body.__expoFilePath === 'string'

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
    const requestId = request.requestId

    let setCookies: ReadonlyArray<string> = []
    if (!Cookies.isEmpty(response.cookies)) {
      setCookies = Cookies.toSetCookieHeaders(response.cookies)
    }
    const headers = expandHeaders(response.headers, setCookies)

    if (request.method === 'HEAD') {
      yield* Effect.promise(() =>
        NativeModule.respondToRequest(requestId, response.status, headers, '', 'utf8')
      )
      return
    }

    response = App.unsafeEjectStreamScope(response)
    const body = response.body

    switch (body._tag) {
      case 'Empty': {
        yield* Effect.promise(() =>
          NativeModule.respondToRequest(requestId, response.status, headers, '', 'utf8')
        )
        break
      }
      case 'Raw': {
        const rawBody = body.body
        if (isExpoFileBody(rawBody)) {
          yield* Effect.promise(() =>
            NativeModule.respondToRequestWithFile(
              requestId,
              response.status,
              headers,
              rawBody.__expoFilePath,
              rawBody.start ?? null,
              rawBody.end ?? null
            )
          )
        } else {
          let rawText = ''
          if (typeof rawBody === 'string') {
            rawText = rawBody
          } else if (rawBody != null) {
            rawText = JSON.stringify(rawBody)
          }
          yield* Effect.promise(() =>
            NativeModule.respondToRequest(requestId, response.status, headers, rawText, 'utf8')
          )
        }
        break
      }
      case 'Uint8Array': {
        if (isTextContentType(body.contentType)) {
          const text = new TextDecoder('utf-8').decode(body.body)
          yield* Effect.promise(() =>
            NativeModule.respondToRequest(requestId, response.status, headers, text, 'utf8')
          )
        } else {
          const b64 = encodeBase64(body.body)
          yield* Effect.promise(() =>
            NativeModule.respondToRequest(requestId, response.status, headers, b64, 'base64')
          )
        }
        break
      }
      case 'FormData': {
        yield* Effect.promise(() =>
          NativeModule.respondToRequest(
            requestId,
            response.status,
            headers,
            'FormData responses are not supported in expo-effect-platform v1',
            'utf8'
          )
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
        const b64 = encodeBase64(combined)
        yield* Effect.promise(() =>
          NativeModule.respondToRequest(requestId, response.status, headers, b64, 'base64')
        )
        break
      }
    }
  })

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = (
  port: number,
  options?: ServerOptions
): Effect.Effect<Server.HttpServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.promise(() => NativeModule.startServer(port, options)),
      () => Effect.promise(() => NativeModule.stopServer(5))
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
          const app = App.toHandled(httpApp, handleResponse, middleware)

          const subscription = NativeModule.addListener(
            'onHttpRequest',
            (payload: OnHttpRequestPayload) => {
              const request = new ServerRequestImpl(payload, payload.path)
              runFork(Effect.provideService(app, ServerRequest.HttpServerRequest, request))
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
