/* oxlint-disable typescript-eslint/no-unsafe-type-assertion, typescript-eslint/unbound-method */
import * as Cookies from '@effect/platform/Cookies'
import { fc, test as fcTest } from '@fast-check/jest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as Stream from 'effect/Stream'
import type ExpoEffectPlatformModuleType from '../ExpoEffectPlatformModule.ts'

// ---------------------------------------------------------------------------
// Mock the native module before importing anything that uses it
// ---------------------------------------------------------------------------

const mockStartServer = jest.fn().mockResolvedValue(undefined)
const mockStopServer = jest.fn().mockResolvedValue(undefined)
const mockRespondToRequest = jest.fn().mockResolvedValue(undefined)
const mockRespondToRequestWithFile = jest.fn().mockResolvedValue(undefined)
const mockGetNetworkInterfaces = jest.fn().mockReturnValue({ en0: '192.168.1.100' })
const mockAddListener = jest.fn().mockReturnValue({ remove: jest.fn() })

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

import type { OnHttpRequestPayload } from '../ExpoEffectPlatform.types.ts'

// `require` (not `import`) is load-bearing: an ES import of
// `'../ExpoEffectPlatformModule.ts'` (with extension) would not be matched by
// `jest.mock('../ExpoEffectPlatformModule', ...)` above and would fall through
// to the real module, which calls `requireNativeModule` and crashes outside
// Expo. This `require` matches the mock path exactly and runs after the mock
// has been registered.
// oxlint-disable-next-line typescript-eslint/no-unsafe-assignment
const NativeModule: typeof ExpoEffectPlatformModuleType =
  require('../ExpoEffectPlatformModule').default

// Reach inside the implementation file so the unit tests actually exercise
// `new ServerRequestImpl(...)` rather than just the test helper that builds
// mock payloads.
//
// `require` (not `import`) is load-bearing: jest hoists `jest.mock()` above all
// ES imports, but the mock factory above captures `mockStartServer` etc. by
// reference. An ES import here would also be hoisted and would resolve
// `../internal/httpServer` before those mock variables are initialized,
// breaking the factory. `require` runs in source order, after the mocks.
const { ServerRequestImpl } = require('../internal/httpServer.ts') as {
  ServerRequestImpl: new (
    payload: OnHttpRequestPayload,
    url: string
  ) => {
    method: string
    url: string
    originalUrl: string
    headers: Record<string, string | ReadonlyArray<string>>
    cookies: Record<string, string>
    remoteAddress: Option.Option<string>
    requestId: string
    text: Effect.Effect<string, unknown>
    json: Effect.Effect<unknown, unknown>
    stream: Stream.Stream<Uint8Array, unknown>
    arrayBuffer: Effect.Effect<ArrayBuffer, unknown>
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<OnHttpRequestPayload> = {}): OnHttpRequestPayload {
  return {
    requestId: 'test-request-123',
    method: 'GET',
    path: '/test?foo=bar',
    headers: {
      'content-type': ['application/json'],
      cookie: ['session=abc123; theme=dark'],
    },
    body: '{"hello":"world"}',
    bodyBase64: null,
    bodyFilePath: null,
    ip: '192.168.1.50',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: ServerRequestImpl — exercise the class directly
// ---------------------------------------------------------------------------

describe('ServerRequestImpl', () => {
  test('method is uppercased from the lowercase payload', () => {
    const req = new ServerRequestImpl(makePayload({ method: 'post' }), '/x')
    expect(req.method).toBe('POST')
  })

  test('url comes from the constructor argument, originalUrl from the payload', () => {
    const req = new ServerRequestImpl(
      makePayload({ path: '/api/v1/data?q=test' }),
      '/api/v1/data?q=test'
    )
    expect(req.url).toBe('/api/v1/data?q=test')
    expect(req.originalUrl).toBe('/api/v1/data?q=test')
  })

  test('headers are exposed as Effect Headers (lowercased keys, comma-joined for multi-values)', () => {
    const req = new ServerRequestImpl(
      makePayload({
        headers: {
          'Content-Type': ['application/json'],
          'X-Custom': ['v1', 'v2'],
        },
      }),
      '/'
    )
    expect(req.headers['content-type']).toBe('application/json')
    // Effect's `Headers.fromInput` collapses array values with `, ` per RFC 7230;
    // we accept this lossiness at the handler API boundary because the
    // `Headers` type is `Record<string, string>`. Multi-Set-Cookie is preserved
    // separately via the response `Cookies` channel.
    expect(req.headers['x-custom']).toBe('v1, v2')
  })

  test('cookies are parsed from the cookie header values', () => {
    const req = new ServerRequestImpl(
      makePayload({ headers: { cookie: ['session=abc123; theme=dark'] } }),
      '/'
    )
    expect(req.cookies).toEqual({ session: 'abc123', theme: 'dark' })
  })

  test('cookies fold across multiple Cookie header values', () => {
    // Some clients send multiple Cookie headers. Joining them with `; ` is
    // the standard concatenation per RFC 6265.
    const req = new ServerRequestImpl(makePayload({ headers: { cookie: ['a=1', 'b=2'] } }), '/')
    expect(req.cookies).toEqual({ a: '1', b: '2' })
  })

  test('remoteAddress filters out empty/whitespace IPs as none', () => {
    expect(Option.isNone(new ServerRequestImpl(makePayload({ ip: '' }), '/').remoteAddress)).toBe(
      true
    )
    expect(
      Option.isNone(new ServerRequestImpl(makePayload({ ip: '   ' }), '/').remoteAddress)
    ).toBe(true)
    const some = new ServerRequestImpl(makePayload({ ip: '10.0.0.1' }), '/').remoteAddress
    expect(Option.isSome(some)).toBe(true)
    expect(Option.getOrThrow(some)).toBe('10.0.0.1')
  })

  test('text body returns the inline payload string', async () => {
    const req = new ServerRequestImpl(makePayload({ body: 'hello world' }), '/')
    const text = await Effect.runPromise(req.text)
    expect(text).toBe('hello world')
  })

  test('text body decodes a base64 payload to UTF-8 text', async () => {
    const b64 = Buffer.from('hello bytes', 'utf-8').toString('base64')
    const req = new ServerRequestImpl(makePayload({ body: null, bodyBase64: b64 }), '/')
    const text = await Effect.runPromise(req.text)
    expect(text).toBe('hello bytes')
  })

  test('json parses the inline body', async () => {
    const req = new ServerRequestImpl(makePayload({ body: '{"hello":"world","n":42}' }), '/')
    const json = (await Effect.runPromise(req.json)) as { hello: string; n: number }
    expect(json).toEqual({ hello: 'world', n: 42 })
  })

  test('arrayBuffer round-trips bytes for base64 bodies', async () => {
    const original = new Uint8Array([0xff, 0x00, 0xab, 0xcd])
    const b64 = Buffer.from(original).toString('base64')
    const req = new ServerRequestImpl(makePayload({ body: null, bodyBase64: b64 }), '/')
    const ab = await Effect.runPromise(req.arrayBuffer)
    expect(new Uint8Array(ab)).toEqual(original)
  })

  test('toJSON returns the documented shape', () => {
    const req = new ServerRequestImpl(makePayload({ method: 'PUT', path: '/x' }), '/x')
    expect((req as unknown as { toJSON: () => unknown }).toJSON()).toEqual({
      _id: '@effect/platform/HttpServerRequest',
      method: 'PUT',
      url: '/x',
    })
  })
})

// ---------------------------------------------------------------------------
// Property tests — concentrate on the parsing/mapping seams that are most
// likely to break on edge cases (header casing, cookie shape, status codes,
// body-threshold logic).
// ---------------------------------------------------------------------------

describe('ServerRequestImpl property tests', () => {
  fcTest.prop({
    method: fc.constantFrom('get', 'post', 'put', 'delete', 'head', 'options', 'patch'),
  })('method is always uppercased to a known HTTP verb', ({ method }) => {
    const req = new ServerRequestImpl(makePayload({ method }), '/')
    expect(req.method).toBe(method.toUpperCase())
  })

  fcTest.prop({
    ip: fc.oneof(
      fc.constant(''),
      fc.constant('   '),
      fc.constant('\t'),
      fc.constantFrom('0.0.0.0', '127.0.0.1', '10.0.0.1', '::1', '2001:db8::1')
    ),
  })('remoteAddress maps blank IPs to None and non-blank to Some', ({ ip }) => {
    const req = new ServerRequestImpl(makePayload({ ip }), '/')
    if (ip.trim().length === 0) {
      expect(Option.isNone(req.remoteAddress)).toBe(true)
    } else {
      expect(Option.isSome(req.remoteAddress)).toBe(true)
      expect(Option.getOrThrow(req.remoteAddress)).toBe(ip)
    }
  })

  fcTest.prop({
    cookies: fc.dictionary(
      fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,16}$/),
      // RFC 6265 cookie-octet alphabet (subset).
      fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
      { maxKeys: 6 }
    ),
  })('cookies survive a header round-trip when serialized with `; ` joins', ({ cookies }) => {
    const header = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ')
    const req = new ServerRequestImpl(makePayload({ headers: { cookie: [header] } }), '/')
    expect(req.cookies).toEqual(cookies)
  })
})

// ---------------------------------------------------------------------------
// Tests: Native module interaction (signature shape)
// ---------------------------------------------------------------------------

describe('native module interaction', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('respondToRequest now takes (id, status, headers, body, encoding)', async () => {
    await NativeModule.respondToRequest('req-1', 200, { 'x-test': ['v'] }, 'hello', 'utf8')
    expect(mockRespondToRequest).toHaveBeenCalledWith(
      'req-1',
      200,
      { 'x-test': ['v'] },
      'hello',
      'utf8'
    )
  })

  test('respondToRequestWithFile takes start/end byte range', async () => {
    await NativeModule.respondToRequestWithFile(
      'req-2',
      206,
      { 'content-type': ['image/dicom'] },
      '/data/scan.dcm',
      0,
      512
    )
    expect(mockRespondToRequestWithFile).toHaveBeenCalledWith(
      'req-2',
      206,
      { 'content-type': ['image/dicom'] },
      '/data/scan.dcm',
      0,
      512
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: ExpoFileBody sentinel detection
// ---------------------------------------------------------------------------

describe('ExpoFileBody sentinel', () => {
  test('file body sentinel has correct shape', () => {
    const body = { __expoFilePath: '/path/to/file.dcm', start: 0, end: undefined }
    expect(body.__expoFilePath).toBe('/path/to/file.dcm')
    expect(typeof body.__expoFilePath).toBe('string')
    expect('__expoFilePath' in body).toBe(true)
  })

  test('non-file body does not match sentinel', () => {
    const body = { data: 'hello' }
    expect('__expoFilePath' in body).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: Cookie parsing helpers
// ---------------------------------------------------------------------------

describe('cookie handling', () => {
  test('cookies are parsed from header', () => {
    const parsed = Cookies.parseHeader('session=abc123; theme=dark')
    expect(parsed['session']).toBe('abc123')
    expect(parsed['theme']).toBe('dark')
  })

  test('empty cookie header returns empty record', () => {
    const parsed = Cookies.parseHeader('')
    expect(Object.keys(parsed).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: Server lifecycle (signature shape)
// ---------------------------------------------------------------------------

describe('server lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('startServer is callable with options', async () => {
    await NativeModule.startServer(8080, {
      handlerTimeoutSeconds: 30,
      bodyDiskThresholdBytes: 5_000_000,
      maxConcurrentRequests: 64,
    })
    expect(mockStartServer).toHaveBeenCalledWith(8080, {
      handlerTimeoutSeconds: 30,
      bodyDiskThresholdBytes: 5_000_000,
      maxConcurrentRequests: 64,
    })
  })

  test('stopServer is callable', async () => {
    await NativeModule.stopServer(5)
    expect(mockStopServer).toHaveBeenCalledWith(5)
  })

  test('addListener returns subscription with remove', () => {
    const sub = NativeModule.addListener('onHttpRequest', () => {})
    expect(sub.remove).toBeDefined()
    expect(mockAddListener).toHaveBeenCalledWith('onHttpRequest', expect.any(Function))
  })
})
