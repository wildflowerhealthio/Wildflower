import * as ServerRequest from '@effect/platform/HttpServerRequest'
import * as HttpServerResponse from '@effect/platform/HttpServerResponse'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'

import type { OnHttpRequestPayload } from '../ExpoEffectPlatform.types.ts'

// ---------------------------------------------------------------------------
// Mock native module
// ---------------------------------------------------------------------------

const mockStartServer = jest.fn().mockResolvedValue(undefined)
const mockStopServer = jest.fn().mockResolvedValue(undefined)
const mockRespondToRequest = jest.fn().mockResolvedValue(undefined)
const mockRespondToRequestWithFile = jest.fn().mockResolvedValue(undefined)
const mockGetNetworkInterfaces = jest.fn().mockReturnValue({ en0: '192.168.1.100' })
const mockRemoveSub = jest.fn()
const mockAddListener = jest.fn().mockReturnValue({ remove: mockRemoveSub })

jest.mock('../ExpoEffectPlatformModule', () => ({
  __esModule: true,
  default: {
    startServer: mockStartServer,
    stopServer: mockStopServer,
    respondToRequest: mockRespondToRequest,
    respondToRequestWithFile: mockRespondToRequestWithFile,
    getNetworkInterfaces: mockGetNetworkInterfaces,
    addListener: mockAddListener,
  },
}))

const { make } = require('../internal/httpServer') as typeof import('../internal/httpServer')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let reqCounter = 0

function makePayload(overrides: Partial<OnHttpRequestPayload> = {}): OnHttpRequestPayload {
  return {
    requestId: `req-${++reqCounter}`,
    method: 'GET',
    path: '/',
    headers: {},
    body: null,
    bodyFilePath: null,
    ip: '127.0.0.1',
    ...overrides,
  }
}

function captureListener(): (payload: OnHttpRequestPayload) => void {
  const lastCall = mockAddListener.mock.calls[mockAddListener.mock.calls.length - 1]
  if (!lastCall) throw new Error('No listener captured — was serve() called?')
  return lastCall[1]
}

function whenRespondedTo(mock: jest.Mock = mockRespondToRequest, timeout = 3000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Response timeout after ${timeout}ms`)),
      timeout
    )
    mock.mockImplementationOnce((..._args: any[]) => {
      clearTimeout(timer)
      resolve()
      return Promise.resolve()
    })
  })
}

/** Run a full request → response cycle through the Effect pipeline */
async function runWithServer(
  app: any,
  payload: OnHttpRequestPayload,
  responseMock: jest.Mock = mockRespondToRequest
): Promise<void> {
  const responded = whenRespondedTo(responseMock)
  const program = Effect.gen(function* () {
    const server = yield* make(8080)
    yield* server.serve(app)
    captureListener()(payload)
    yield* Effect.promise(() => responded)
  }).pipe(Effect.scoped)
  await Effect.runPromise(program as Effect.Effect<void>)
}

// ---------------------------------------------------------------------------
// Tests: Response handling
// ---------------------------------------------------------------------------

describe('integration: response handling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    reqCounter = 0
    mockRespondToRequest.mockResolvedValue(undefined)
    mockRespondToRequestWithFile.mockResolvedValue(undefined)
    mockAddListener.mockReturnValue({ remove: mockRemoveSub })
  })

  test('text response', async () => {
    const app = Effect.succeed(HttpServerResponse.text('Hello World'))
    await runWithServer(app, makePayload({ requestId: 'req-text' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-text',
      200,
      expect.any(Object),
      'Hello World'
    )
  }, 5000)

  test('JSON response', async () => {
    const app = Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok', count: 42 }))
    await runWithServer(app, makePayload({ requestId: 'req-json' }))
    const body = JSON.parse(mockRespondToRequest.mock.calls[0][3])
    expect(body).toEqual({ status: 'ok', count: 42 })
  }, 5000)

  test('empty response defaults to 204', async () => {
    const app = Effect.succeed(HttpServerResponse.empty())
    await runWithServer(app, makePayload({ requestId: 'req-empty' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith('req-empty', 204, expect.any(Object), '')
  }, 5000)

  test('file response via ExpoFileBody sentinel', async () => {
    const app = Effect.succeed(
      HttpServerResponse.raw(
        { __expoFilePath: '/data/scan.dcm', start: 0, end: undefined },
        { status: 200, contentType: 'application/dicom' }
      )
    )
    await runWithServer(app, makePayload({ requestId: 'req-file' }), mockRespondToRequestWithFile)
    expect(mockRespondToRequestWithFile).toHaveBeenCalledWith(
      'req-file',
      200,
      expect.any(Object),
      '/data/scan.dcm'
    )
    expect(mockRespondToRequest).not.toHaveBeenCalled()
  }, 5000)

  test('raw string body', async () => {
    const app = Effect.succeed(HttpServerResponse.raw('raw string data', { status: 200 }))
    await runWithServer(app, makePayload({ requestId: 'req-raw' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-raw',
      200,
      expect.any(Object),
      'raw string data'
    )
  }, 5000)

  test('stream response is buffered and sent', async () => {
    const encoder = new TextEncoder()
    const app = Effect.succeed(
      HttpServerResponse.stream(
        Stream.fromIterable([encoder.encode('hello '), encoder.encode('world')])
      )
    )
    await runWithServer(app, makePayload({ requestId: 'req-stream' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-stream',
      200,
      expect.any(Object),
      'hello world'
    )
  }, 5000)

  test('HEAD request returns empty body', async () => {
    const app = Effect.succeed(HttpServerResponse.text('This body should be ignored'))
    await runWithServer(app, makePayload({ requestId: 'req-head', method: 'HEAD' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith('req-head', 200, expect.any(Object), '')
  }, 5000)

  test('response includes set-cookie header', async () => {
    // setCookie returns an Effect, so use gen to yield it
    const app = Effect.gen(function* () {
      return yield* HttpServerResponse.setCookie(
        HttpServerResponse.empty({ status: 200 }),
        'session',
        'abc123'
      )
    }).pipe(Effect.orDie)

    await runWithServer(app, makePayload({ requestId: 'req-cookie' }))
    const headers = mockRespondToRequest.mock.calls[0][2]
    expect(headers['set-cookie']).toContain('session=abc123')
  }, 5000)
})

// ---------------------------------------------------------------------------
// Tests: Request properties
// ---------------------------------------------------------------------------

describe('integration: request properties', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    reqCounter = 0
    mockRespondToRequest.mockResolvedValue(undefined)
    mockRespondToRequestWithFile.mockResolvedValue(undefined)
    mockAddListener.mockReturnValue({ remove: mockRemoveSub })
  })

  test('handler receives correct method, url, and headers', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      return HttpServerResponse.unsafeJson({
        method: req.method,
        url: req.url,
        originalUrl: req.originalUrl,
        contentType: req.headers['content-type'],
      })
    }).pipe(Effect.orDie)

    await runWithServer(
      app,
      makePayload({
        requestId: 'req-props',
        method: 'post',
        path: '/api/data?q=test',
        headers: { 'content-type': 'application/json' },
      })
    )

    const body = JSON.parse(mockRespondToRequest.mock.calls[0][3])
    expect(body.method).toBe('POST')
    expect(body.url).toBe('/api/data?q=test')
    expect(body.originalUrl).toBe('/api/data?q=test')
    expect(body.contentType).toBe('application/json')
  }, 5000)

  test('handler receives remote address', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      return HttpServerResponse.text(Option.getOrElse(req.remoteAddress, () => 'none'))
    }).pipe(Effect.orDie)

    await runWithServer(app, makePayload({ requestId: 'req-ip', ip: '10.0.0.42' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-ip',
      200,
      expect.any(Object),
      '10.0.0.42'
    )
  }, 5000)

  test('empty IP returns none for remoteAddress', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      return HttpServerResponse.text(Option.getOrElse(req.remoteAddress, () => 'none'))
    }).pipe(Effect.orDie)

    await runWithServer(app, makePayload({ requestId: 'req-no-ip', ip: '' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith('req-no-ip', 200, expect.any(Object), 'none')
  }, 5000)

  test('handler receives parsed cookies', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      return HttpServerResponse.unsafeJson(req.cookies)
    }).pipe(Effect.orDie)

    await runWithServer(
      app,
      makePayload({
        requestId: 'req-cookies',
        headers: { cookie: 'session=xyz; theme=dark' },
      })
    )

    const cookies = JSON.parse(mockRespondToRequest.mock.calls[0][3])
    expect(cookies.session).toBe('xyz')
    expect(cookies.theme).toBe('dark')
  }, 5000)

  test('handler reads request body as text', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      const body = yield* req.text
      return HttpServerResponse.text(`Echo: ${body}`)
    }).pipe(Effect.orDie)

    await runWithServer(
      app,
      makePayload({
        requestId: 'req-text-body',
        method: 'POST',
        body: 'hello world',
      })
    )

    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-text-body',
      200,
      expect.any(Object),
      'Echo: hello world'
    )
  }, 5000)

  test('handler reads request body as JSON', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      const body = yield* req.json
      return HttpServerResponse.unsafeJson(body)
    }).pipe(Effect.orDie)

    await runWithServer(
      app,
      makePayload({
        requestId: 'req-json-body',
        method: 'POST',
        body: '{"name":"test","value":42}',
      })
    )

    const responseBody = JSON.parse(mockRespondToRequest.mock.calls[0][3])
    expect(responseBody).toEqual({ name: 'test', value: 42 })
  }, 5000)

  test('handler reads URL-encoded body params', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      const params = yield* req.urlParamsBody
      return HttpServerResponse.unsafeJson(Object.fromEntries(params))
    }).pipe(Effect.orDie)

    await runWithServer(
      app,
      makePayload({
        requestId: 'req-params',
        method: 'POST',
        body: 'name=test&age=25',
      })
    )

    const responseBody = JSON.parse(mockRespondToRequest.mock.calls[0][3])
    expect(responseBody.name).toBe('test')
    expect(responseBody.age).toBe('25')
  }, 5000)

  test('empty body returns empty string for text', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      const body = yield* req.text
      return HttpServerResponse.text(`[${body}]`)
    }).pipe(Effect.orDie)

    await runWithServer(
      app,
      makePayload({
        requestId: 'req-empty-body',
        body: null,
        bodyFilePath: null,
      })
    )

    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-empty-body',
      200,
      expect.any(Object),
      '[]'
    )
  }, 5000)

  test('multipart access returns error', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      const result = yield* Effect.either(req.multipart as any)
      if (result._tag === 'Left') {
        return HttpServerResponse.text('multipart-not-supported', { status: 501 })
      }
      return HttpServerResponse.text('unexpected')
    }).pipe(Effect.orDie)

    await runWithServer(app, makePayload({ requestId: 'req-multipart' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-multipart',
      501,
      expect.any(Object),
      'multipart-not-supported'
    )
  }, 5000)

  test('upgrade access returns error', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      const result = yield* Effect.either(req.upgrade)
      if (result._tag === 'Left') {
        return HttpServerResponse.text('upgrade-not-supported', { status: 501 })
      }
      return HttpServerResponse.text('unexpected')
    }).pipe(Effect.orDie)

    await runWithServer(app, makePayload({ requestId: 'req-upgrade' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-upgrade',
      501,
      expect.any(Object),
      'upgrade-not-supported'
    )
  }, 5000)

  test('request.modify creates new request with overrides', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      const modified = req.modify({ url: '/overridden' })
      return HttpServerResponse.text(modified.url)
    }).pipe(Effect.orDie)

    await runWithServer(app, makePayload({ requestId: 'req-modify', path: '/original' }))
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-modify',
      200,
      expect.any(Object),
      '/overridden'
    )
  }, 5000)

  test('request.toJSON returns expected shape', async () => {
    const app = Effect.gen(function* () {
      const req = yield* ServerRequest.HttpServerRequest
      return HttpServerResponse.unsafeJson((req as any).toJSON())
    }).pipe(Effect.orDie)

    await runWithServer(
      app,
      makePayload({
        requestId: 'req-tojson',
        method: 'PUT',
        path: '/test',
      })
    )

    const body = JSON.parse(mockRespondToRequest.mock.calls[0][3])
    expect(body._id).toBe('@effect/platform/HttpServerRequest')
    expect(body.method).toBe('PUT')
    expect(body.url).toBe('/test')
  }, 5000)
})

// ---------------------------------------------------------------------------
// Tests: Server lifecycle
// ---------------------------------------------------------------------------

describe('integration: server lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    reqCounter = 0
    mockRespondToRequest.mockResolvedValue(undefined)
    mockRespondToRequestWithFile.mockResolvedValue(undefined)
    mockAddListener.mockReturnValue({ remove: mockRemoveSub })
  })

  test('startServer called on acquire, stopServer on release', async () => {
    const program = Effect.gen(function* () {
      const server = yield* make(8080, { handlerTimeoutSeconds: 30 })
      yield* server.serve(Effect.succeed(HttpServerResponse.empty()) as any)
    }).pipe(Effect.scoped)

    await Effect.runPromise(program as Effect.Effect<void>)

    expect(mockStartServer).toHaveBeenCalledWith(8080, { handlerTimeoutSeconds: 30 })
    expect(mockStopServer).toHaveBeenCalledWith(5)
  }, 5000)

  test('event listener removed on scope close', async () => {
    const program = Effect.gen(function* () {
      const server = yield* make(8080)
      yield* server.serve(Effect.succeed(HttpServerResponse.empty()) as any)
    }).pipe(Effect.scoped)

    await Effect.runPromise(program as Effect.Effect<void>)

    expect(mockAddListener).toHaveBeenCalledWith('onHttpRequest', expect.any(Function))
    expect(mockRemoveSub).toHaveBeenCalled()
  }, 5000)

  test('server address reflects network interfaces', async () => {
    mockGetNetworkInterfaces.mockReturnValue({ en0: '10.0.1.50' })

    const program = Effect.gen(function* () {
      const server = yield* make(9090)
      expect(server.address._tag).toBe('TcpAddress')
      expect((server.address as any).hostname).toBe('10.0.1.50')
      expect((server.address as any).port).toBe(9090)
    }).pipe(Effect.scoped)

    await Effect.runPromise(program as Effect.Effect<void>)
  }, 5000)

  test('falls back to wlan0 when en0 unavailable', async () => {
    mockGetNetworkInterfaces.mockReturnValue({ wlan0: '192.168.0.50' })

    const program = Effect.gen(function* () {
      const server = yield* make(8080)
      expect((server.address as any).hostname).toBe('192.168.0.50')
    }).pipe(Effect.scoped)

    await Effect.runPromise(program as Effect.Effect<void>)
  }, 5000)

  test('falls back to 0.0.0.0 when no interfaces available', async () => {
    mockGetNetworkInterfaces.mockReturnValue({})

    const program = Effect.gen(function* () {
      const server = yield* make(8080)
      expect((server.address as any).hostname).toBe('0.0.0.0')
    }).pipe(Effect.scoped)

    await Effect.runPromise(program as Effect.Effect<void>)
  }, 5000)

  test('server address uses provided hostname over network interfaces', async () => {
    mockGetNetworkInterfaces.mockReturnValue({ en0: '10.0.1.50' })

    const program = Effect.gen(function* () {
      const server = yield* make(9090, { hostname: '127.0.0.1' })
      expect(server.address._tag).toBe('TcpAddress')
      expect((server.address as any).hostname).toBe('127.0.0.1')
      expect((server.address as any).port).toBe(9090)
    }).pipe(Effect.scoped)

    await Effect.runPromise(program as Effect.Effect<void>)
  }, 5000)

  test('startServer passes hostname option to native module', async () => {
    const program = Effect.gen(function* () {
      const server = yield* make(8080, { hostname: '127.0.0.1' })
      yield* server.serve(Effect.succeed(HttpServerResponse.empty()) as any)
    }).pipe(Effect.scoped)

    await Effect.runPromise(program as Effect.Effect<void>)

    expect(mockStartServer).toHaveBeenCalledWith(8080, { hostname: '127.0.0.1' })
  }, 5000)
})
