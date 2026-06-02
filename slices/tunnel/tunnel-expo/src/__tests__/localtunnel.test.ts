/* oxlint-disable typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-unsafe-assignment */
/**
 * Tests for the `localtunnel(...)` entry point covering the four public
 * overloads (options-promise, options-callback, port-promise, port-callback).
 *
 * The native module is mocked so `TunnelCluster` never reaches into Expo's
 * `requireNativeModule` (which would crash outside an Expo runtime). `fetch`
 * is mocked on `globalThis` so the assignment request resolves predictably
 * with no real network I/O.
 */

// ---------------------------------------------------------------------------
// Native module mock — register before importing anything that pulls it in.
// ---------------------------------------------------------------------------

import type { start as startLocaltunnel } from '../localtunnel.ts'
import type TunnelType from '../Tunnel.ts'

const mockCreateTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseAllTunnelConnections = jest.fn().mockResolvedValue(undefined)
const mockAddListener = jest.fn().mockReturnValue({ remove: jest.fn() })

jest.mock('../ExpoLocaltunnelModule', () => ({
  __esModule: true,
  default: {
    createTunnelConnection: mockCreateTunnelConnection,
    closeTunnelConnection: mockCloseTunnelConnection,
    closeAllTunnelConnections: mockCloseAllTunnelConnections,
    addListener: mockAddListener,
  },
}))

// `require` (not `import`) for the unit under test — see the analogous note
// in the sister package's tests. ES imports get hoisted above `jest.mock()`'s
// captured factory variables and would race; `require` runs in source order.
const start: typeof startLocaltunnel = require('../localtunnel.ts').start
const Tunnel: typeof TunnelType = require('../Tunnel.ts').default

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AssignBody {
  id: string
  port: number
  url: string
  ip?: string
  cached_url?: string
  max_conn_count?: number
}

function makeAssignBody(overrides: Partial<AssignBody> = {}): AssignBody {
  return {
    id: 'tunnel-id',
    port: 12345,
    url: 'https://tunnel-id.localtunnel.me',
    max_conn_count: 1,
    ...overrides,
  }
}

function mockFetchOnceWithBody(body: AssignBody): jest.Mock {
  const fn = jest.fn().mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  })
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('localtunnel() overloads', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('options-only form returns a Promise that resolves to a Tunnel', async () => {
    mockFetchOnceWithBody(makeAssignBody())
    const tunnel = await start({ port: 8000 })
    expect(tunnel).toBeInstanceOf(Tunnel)
    expect(tunnel.url).toBe('https://tunnel-id.localtunnel.me')
    expect(tunnel.clientId).toBe('tunnel-id')
    void tunnel.close()
  })

  test('options + callback form returns the Tunnel synchronously and invokes the callback after fetch', (done) => {
    mockFetchOnceWithBody(makeAssignBody({ id: 'cb-id', url: 'https://cb-id.localtunnel.me' }))

    const sync = start({ port: 8000 }, (err, tunnel) => {
      try {
        expect(err).toBeNull()
        expect(tunnel).toBeInstanceOf(Tunnel)
        expect(tunnel).toBe(sync)
        expect(sync.url).toBe('https://cb-id.localtunnel.me')
        void sync.close()
        done()
      } catch (assertionErr) {
        done(assertionErr)
      }
    })

    // Synchronously returned Tunnel — `url` is not yet set because fetch is async.
    expect(sync).toBeInstanceOf(Tunnel)
    expect(sync.url).toBeUndefined()
  })

  test('port-first form (port + opts) returns a Promise resolving to a Tunnel', async () => {
    mockFetchOnceWithBody(makeAssignBody())
    const tunnel = await start(8000, { localHost: 'foo' })
    expect(tunnel).toBeInstanceOf(Tunnel)
    expect(tunnel.opts.port).toBe(8000)
    expect(tunnel.opts.localHost).toBe('foo')
    void tunnel.close()
  })

  test('port-first form + callback returns Tunnel synchronously', (done) => {
    mockFetchOnceWithBody(makeAssignBody())
    const sync = start(8000, undefined, (err, tunnel) => {
      try {
        expect(err).toBeNull()
        expect(tunnel).toBe(sync)
        void sync.close()
        done()
      } catch (assertionErr) {
        done(assertionErr)
      }
    })
    expect(sync).toBeInstanceOf(Tunnel)
  })

  test('promise rejects when localHttps is set (unsupported in expo-localtunnel)', async () => {
    mockFetchOnceWithBody(makeAssignBody())
    await expect(start({ port: 8000, localHttps: true })).rejects.toThrow(/localHttps/)
  })

  test('default host is https://localtunnel.me and the assignment URI uses ?new when no subdomain is given', async () => {
    const fn = mockFetchOnceWithBody(makeAssignBody())
    const tunnel = await start({ port: 8000 })
    // First positional arg is the URL string.
    expect(fn.mock.calls[0]?.[0]).toBe('https://localtunnel.me/?new')
    void tunnel.close()
  })

  test('explicit subdomain is appended to the assignment URI in place of ?new', async () => {
    const fn = mockFetchOnceWithBody(makeAssignBody())
    const tunnel = await start({ port: 8000, subdomain: 'mysub' })
    expect(fn.mock.calls[0]?.[0]).toBe('https://localtunnel.me/mysub')
    void tunnel.close()
  })
})
