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
import { Effect, FiberSet, Inspectable, Layer, Option, Stream } from 'effect'
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
    return Option.fromNullable(this.remoteAddressOverride).pipe(
      Option.orElse(() => Option.fromNullable(this.source.ip))
    )
  }

  get headers(): Headers.Headers {
    this.headersOverride ??= Headers.fromInput(Object.entries(this.source.headers))
    return this.headersOverride
  }

  private cachedCookies: RecordNS.ReadonlyRecord<string, string> | undefined
  get cookies(): RecordNS.ReadonlyRecord<string, string> {
    if (this.cachedCookies) {
      return this.cachedCookies
    }
    return (this.cachedCookies = Cookies.parseHeader(this.headers.cookie ?? ''))
  }

  // -- Body access --

  private textEffect: Effect.Effect<string, Error.RequestError> | undefined
  get text(): Effect.Effect<string, Error.RequestError> {
    if (this.textEffect) {
      return this.textEffect
    }
    let source: Effect.Effect<string, Error.RequestError>
    if (this.source.body != null) {
      source = Effect.succeed(this.source.body)
    } else if (this.source.bodyFilePath != null) {
      const filePath = this.source.bodyFilePath
      source = Effect.tryPromise({
        try: () => fetch(`file://${filePath}`).then((r) => r.text()),
        catch: (cause) =>
          new Error.RequestError({
            request: this,
            reason: 'Decode',
            cause,
          }),
      })
    } else {
      source = Effect.succeed('')
    }
    this.textEffect = Effect.runSync(Effect.cached(source))
    return this.textEffect
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

  private arrayBufferEffect: Effect.Effect<ArrayBuffer, Error.RequestError> | undefined
  get arrayBuffer(): Effect.Effect<ArrayBuffer, Error.RequestError> {
    if (this.arrayBufferEffect) {
      return this.arrayBufferEffect
    }
    this.arrayBufferEffect = Effect.runSync(
      Effect.cached(this.text.pipe(Effect.map((t) => new TextEncoder().encode(t).buffer)))
    )
    return this.arrayBufferEffect
  }

  get stream(): Stream.Stream<Uint8Array, Error.RequestError> {
    if (this.source.body != null) {
      return Stream.succeed(new TextEncoder().encode(this.source.body))
    }
    if (this.source.bodyFilePath != null) {
      return Stream.fromEffect(
        Effect.tryPromise({
          try: () =>
            fetch(`file://${this.source.bodyFilePath}`)
              .then((r) => r.arrayBuffer())
              .then((ab) => new Uint8Array(ab)),
          catch: (cause) =>
            new Error.RequestError({
              request: this,
              reason: 'Decode',
              cause,
            }),
        })
      )
    }
    return Stream.succeed(new Uint8Array(0))
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

    const headers: Record<string, string> = { ...response.headers }
    if (!Cookies.isEmpty(response.cookies)) {
      const setCookies = Cookies.toSetCookieHeaders(response.cookies)
      headers['set-cookie'] = setCookies.join(', ')
    }

    if (request.method === 'HEAD') {
      yield* Effect.promise(() =>
        NativeModule.respondToRequest(requestId, response.status, headers, '')
      )
      return
    }

    response = App.unsafeEjectStreamScope(response)
    const body = response.body

    switch (body._tag) {
      case 'Empty': {
        yield* Effect.promise(() =>
          NativeModule.respondToRequest(requestId, response.status, headers, '')
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
              rawBody.__expoFilePath
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
            NativeModule.respondToRequest(requestId, response.status, headers, rawText)
          )
        }
        break
      }
      case 'Uint8Array': {
        const text = new TextDecoder().decode(body.body)
        yield* Effect.promise(() =>
          NativeModule.respondToRequest(requestId, response.status, headers, text)
        )
        break
      }
      case 'FormData': {
        yield* Effect.promise(() =>
          NativeModule.respondToRequest(
            requestId,
            response.status,
            headers,
            'FormData responses are not supported in expo-effect-platform v1'
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
        const text = new TextDecoder().decode(combined)
        yield* Effect.promise(() =>
          NativeModule.respondToRequest(requestId, response.status, headers, text)
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

    const hostname =
      options?.hostname ??
      (() => {
        const interfaces = NativeModule.getNetworkInterfaces()
        return interfaces['en0'] ?? interfaces['wlan0'] ?? '0.0.0.0'
      })()

    return Server.make({
      address: { _tag: 'TcpAddress', hostname, port },
      serve(
        httpApp: App.Default<unknown>,
        middleware?: HttpMiddleware.HttpMiddleware
      ): Effect.Effect<void, never, Scope.Scope> {
        return Effect.gen(function* () {
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

export { make, layer }
export type { ExpoFileBody }
