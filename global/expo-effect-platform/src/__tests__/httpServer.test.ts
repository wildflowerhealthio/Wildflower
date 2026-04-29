import * as Cookies from '@effect/platform/Cookies'

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

import type { OnHttpRequestPayload } from '../ExpoEffectPlatform.types'

const NativeModule = require('../ExpoEffectPlatformModule').default

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<OnHttpRequestPayload> = {}): OnHttpRequestPayload {
  return {
    requestId: 'test-request-123',
    method: 'GET',
    path: '/test?foo=bar',
    headers: { 'content-type': 'application/json', cookie: 'session=abc123; theme=dark' },
    body: '{"hello":"world"}',
    bodyFilePath: null,
    ip: '192.168.1.50',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests: ServerRequestImpl field mapping (via payload shape)
// ---------------------------------------------------------------------------

describe('ServerRequestImpl', () => {
  test('method is uppercased', () => {
    const payload = makePayload({ method: 'post' })
    expect(payload.method.toUpperCase()).toBe('POST')
  })

  test('url comes from path', () => {
    const payload = makePayload({ path: '/api/v1/data?q=test' })
    expect(payload.path).toBe('/api/v1/data?q=test')
  })

  test('headers are present', () => {
    const payload = makePayload()
    expect(payload.headers['content-type']).toBe('application/json')
  })

  test('ip is present', () => {
    const payload = makePayload({ ip: '10.0.0.1' })
    expect(payload.ip).toBe('10.0.0.1')
  })

  test('body is accessible when inline', () => {
    const payload = makePayload({ body: 'hello', bodyFilePath: null })
    expect(payload.body).toBe('hello')
    expect(payload.bodyFilePath).toBeNull()
  })

  test('bodyFilePath is set for large bodies', () => {
    const payload = makePayload({ body: null, bodyFilePath: '/tmp/request-abc.bin' })
    expect(payload.body).toBeNull()
    expect(payload.bodyFilePath).toBe('/tmp/request-abc.bin')
  })
})

// ---------------------------------------------------------------------------
// Tests: Native module interaction
// ---------------------------------------------------------------------------

describe('native module interaction', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('make and layer are exported from internal module', () => {
    const httpServer = require('../internal/httpServer')
    expect(httpServer.layer).toBeDefined()
    expect(typeof httpServer.make).toBe('function')
  })

  test('getNetworkInterfaces returns expected shape', () => {
    const result = NativeModule.getNetworkInterfaces()
    expect(result).toEqual({ en0: '192.168.1.100' })
  })

  test('respondToRequest is called with correct args', async () => {
    await NativeModule.respondToRequest('req-1', 200, {}, '')
    expect(mockRespondToRequest).toHaveBeenCalledWith('req-1', 200, {}, '')
  })

  test('respondToRequestWithFile is called for file responses', async () => {
    await NativeModule.respondToRequestWithFile(
      'req-2',
      200,
      { 'content-type': 'image/dicom' },
      '/data/scan.dcm'
    )
    expect(mockRespondToRequestWithFile).toHaveBeenCalledWith(
      'req-2',
      200,
      { 'content-type': 'image/dicom' },
      '/data/scan.dcm'
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
// Tests: Cookie parsing
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
// Tests: Server lifecycle
// ---------------------------------------------------------------------------

describe('server lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('startServer is callable with options', async () => {
    await NativeModule.startServer(8080, {
      handlerTimeoutSeconds: 30,
      bodyDiskThresholdBytes: 5000000,
    })
    expect(mockStartServer).toHaveBeenCalledWith(8080, {
      handlerTimeoutSeconds: 30,
      bodyDiskThresholdBytes: 5000000,
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
