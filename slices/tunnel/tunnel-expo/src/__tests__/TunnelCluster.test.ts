/* oxlint-disable typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-unsafe-assignment */
/**
 * Tests for `TunnelCluster` — the layer that talks to the native module via
 * Expo's event subscription API. We capture the listener callbacks the
 * cluster registers, then drive them directly so the assertions don't depend
 * on a real Expo runtime.
 */

import { fc, test as fcTest } from '@fast-check/jest'

import type { ExpoLocaltunnelModuleEvents } from '../ExpoLocaltunnel.types.ts'
import type TunnelClusterType from '../TunnelCluster.ts'

// ---------------------------------------------------------------------------
// Native module mock — captures listeners by event name so tests can fire them.
// ---------------------------------------------------------------------------

type EventName = keyof ExpoLocaltunnelModuleEvents
type ListenerOf<E extends EventName> = ExpoLocaltunnelModuleEvents[E]
type AnyListener = (...args: never[]) => void

interface MockSubscription {
  remove: jest.Mock<void, []>
}

const mockCreateTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseTunnelConnection = jest.fn().mockResolvedValue(undefined)
const mockCloseAllTunnelConnections = jest.fn().mockResolvedValue(undefined)
const listenersByEvent = new Map<EventName, AnyListener[]>()
const subscriptions: MockSubscription[] = []

const mockAddListener = jest.fn((event: EventName, listener: AnyListener): MockSubscription => {
  const list = listenersByEvent.get(event) ?? []
  list.push(listener)
  listenersByEvent.set(event, list)

  const sub: MockSubscription = {
    remove: jest.fn(() => {
      const arr = listenersByEvent.get(event)
      if (!arr) return
      const idx = arr.indexOf(listener)
      if (idx >= 0) arr.splice(idx, 1)
    }),
  }
  subscriptions.push(sub)
  return sub
})

jest.mock('../ExpoLocaltunnelModule', () => ({
  __esModule: true,
  default: {
    createTunnelConnection: mockCreateTunnelConnection,
    closeTunnelConnection: mockCloseTunnelConnection,
    closeAllTunnelConnections: mockCloseAllTunnelConnections,
    addListener: mockAddListener,
  },
}))

// `require` (not `import`) — see the analogous note in the sister package's tests.
const TunnelCluster: typeof TunnelClusterType = require('../TunnelCluster.ts').default

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fire<E extends EventName>(event: E, ...args: Parameters<ListenerOf<E>>): void {
  const list = listenersByEvent.get(event) ?? []
  for (const fn of list) {
    ;(fn as unknown as (...a: Parameters<ListenerOf<E>>) => void)(...args)
  }
}

function lastCreateConnectionCall(): {
  connectionId: string
  config: {
    remoteHost: string
    remotePort: number
    localHost: string
    localPort: number
    localHostHeader?: string
  }
} {
  const calls = mockCreateTunnelConnection.mock.calls
  const last = calls[calls.length - 1]
  return { connectionId: last?.[0] as string, config: last?.[1] as never }
}

function reset(): void {
  jest.clearAllMocks()
  listenersByEvent.clear()
  subscriptions.length = 0
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('TunnelCluster lifecycle', () => {
  beforeEach(() => {
    reset()
  })

  test('constructor flushes orphaned native connections and subscribes to native events', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })
    expect(cluster).toBeInstanceOf(TunnelCluster)

    expect(mockCloseAllTunnelConnections).toHaveBeenCalledTimes(1)

    // The cluster registers exactly one listener per documented native event.
    const expected: EventName[] = [
      'onConnectionOpen',
      'onConnectionClose',
      'onConnectionError',
      'onConnectionDead',
      'onRequest',
    ]
    for (const name of expected) {
      expect(listenersByEvent.get(name)?.length ?? 0).toBe(1)
    }
  })

  test('open() calls the native module with camelCase config (remoteHost / remotePort / localHost / localPort / localHostHeader)', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localHost: 'my-host',
      localPort: 3000,
    })
    cluster.open()

    const { connectionId, config } = lastCreateConnectionCall()
    expect(typeof connectionId).toBe('string')
    expect(connectionId.length).toBeGreaterThan(0)
    expect(config).toEqual({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localHost: 'my-host',
      localPort: 3000,
      localHostHeader: 'my-host',
    })
  })

  test('open() prefers `remoteIp` over `remoteHost` for the native `remoteHost` field when an IP is supplied', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remoteIp: '203.0.113.7',
      remotePort: 12345,
      localPort: 3000,
    })
    cluster.open()
    expect(lastCreateConnectionCall().config.remoteHost).toBe('203.0.113.7')
  })

  test('open() defaults `localHost` to "localhost" when the option is omitted, and omits the host-header in that case', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 3000,
    })
    cluster.open()
    const { config } = lastCreateConnectionCall()
    expect(config.localHost).toBe('localhost')
    // When `localHost` is unset the host header should fall through to undefined
    // so the native side does not rewrite the upstream `Host`.
    expect(config.localHostHeader).toBeUndefined()
  })

  test('close() removes every native subscription and clears tracked connections', async () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })
    cluster.open()
    cluster.open()

    const removeCalls = subscriptions.length
    expect(removeCalls).toBeGreaterThan(0)

    await cluster.close()

    for (const sub of subscriptions) {
      expect(sub.remove).toHaveBeenCalledTimes(1)
    }

    // Subsequent native events for previously tracked connectionIds are
    // ignored (the cluster's `connections` set is empty). We can't read the
    // private set, but firing events should not throw and should not emit on
    // the cluster.
    const onError = jest.fn()
    cluster.on('error', onError)
    fire('onConnectionError', {
      connectionId: 'whatever',
      error: 'late event',
      code: 'ETIMEDOUT',
    })
    expect(onError).not.toHaveBeenCalled()

    expect(mockCloseAllTunnelConnections).toHaveBeenCalledTimes(2) // once at construction, once on close
  })

  test('close() awaits the native closeAllTunnelConnections before resolving', async () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    let resolveNative: (() => void) | undefined
    mockCloseAllTunnelConnections.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveNative = resolve
        })
    )

    let resolved = false
    const closing = cluster.close().then(() => {
      resolved = true
    })

    // Let microtasks settle — the native call has been invoked but is parked.
    await Promise.resolve()
    expect(mockCloseAllTunnelConnections).toHaveBeenCalledTimes(2) // construction + close
    expect(resolved).toBe(false)

    // Now resolve the native side. close() should resolve in the next microtask.
    expect(resolveNative).toBeDefined()
    resolveNative?.()
    await closing
    expect(resolved).toBe(true)
  })

  test('close() swallows native rejection (warns, but does not throw) so finalizer chains continue', async () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    mockCloseAllTunnelConnections.mockRejectedValueOnce(new Error('native bork'))
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(cluster.close()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[tunnel\] closeAllTunnelConnections failed after \d+ms$/),
      expect.any(Error)
    )

    warnSpy.mockRestore()
  })

  test('open() forwards a native rejection as an `error` event', async () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    const onError = jest.fn()
    cluster.on('error', onError)

    mockCreateTunnelConnection.mockRejectedValueOnce(new Error('native failure'))
    cluster.open()

    // Let the rejected promise settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0]?.[0] as Error
    expect(err.message).toBe('native failure')
    void cluster.close()
  })
})

// ---------------------------------------------------------------------------
// Native event mapping
// ---------------------------------------------------------------------------

describe('TunnelCluster native event mapping', () => {
  beforeEach(() => {
    reset()
  })

  test('onConnectionOpen for an unknown connectionId is ignored', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    const onOpen = jest.fn()
    cluster.on('open', onOpen)
    fire('onConnectionOpen', { connectionId: 'never-issued' })
    expect(onOpen).not.toHaveBeenCalled()

    void cluster.close()
  })

  test('onConnectionOpen for a known connectionId emits `open`', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    cluster.open()
    const { connectionId } = lastCreateConnectionCall()

    const onOpen = jest.fn()
    cluster.on('open', onOpen)
    fire('onConnectionOpen', { connectionId })
    expect(onOpen).toHaveBeenCalledTimes(1)

    void cluster.close()
  })

  test('ECONNREFUSED native error preserves the native error text (so the local/remote prefix survives) and emits `dead`', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    cluster.open()
    const { connectionId } = lastCreateConnectionCall()

    const onError = jest.fn()
    const onDead = jest.fn()
    cluster.on('error', onError)
    cluster.on('dead', onDead)

    fire('onConnectionError', {
      connectionId,
      error: 'local: failed to connect to /127.0.0.1:8765',
      code: 'ECONNREFUSED',
    })

    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0]?.[0] as Error & { code?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('ECONNREFUSED')
    expect(err.message).toBe(
      'tunnel error (ECONNREFUSED): local: failed to connect to /127.0.0.1:8765'
    )

    expect(onDead).toHaveBeenCalledTimes(1)

    void cluster.close()
  })

  test('non-ECONNREFUSED native error uses the generic message format and attaches the code', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    cluster.open()
    const { connectionId } = lastCreateConnectionCall()

    const onError = jest.fn()
    const onDead = jest.fn()
    cluster.on('error', onError)
    cluster.on('dead', onDead)

    fire('onConnectionError', {
      connectionId,
      error: 'socket hang up',
      code: 'ETIMEDOUT',
    })

    const err = onError.mock.calls[0]?.[0] as Error & { code?: string }
    expect(err.code).toBe('ETIMEDOUT')
    expect(err.message).toBe('tunnel error (ETIMEDOUT): socket hang up')
    expect(onDead).toHaveBeenCalledTimes(1)

    void cluster.close()
  })

  test('onConnectionClose emits `dead` and clears the connection from the tracked set', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    cluster.open()
    const { connectionId } = lastCreateConnectionCall()

    const onDead = jest.fn()
    cluster.on('dead', onDead)
    fire('onConnectionClose', { connectionId })
    expect(onDead).toHaveBeenCalledTimes(1)

    // Second close for the same id is now ignored (connection already cleared).
    fire('onConnectionClose', { connectionId })
    expect(onDead).toHaveBeenCalledTimes(1)

    void cluster.close()
  })

  test('onRequest forwards method/path under the public `request` event', () => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    cluster.open()
    const { connectionId } = lastCreateConnectionCall()

    const onRequest = jest.fn()
    cluster.on('request', onRequest)
    fire('onRequest', { connectionId, method: 'POST', path: '/upload' })
    expect(onRequest).toHaveBeenCalledWith({ method: 'POST', path: '/upload' })

    void cluster.close()
  })
})

// ---------------------------------------------------------------------------
// Property test: regardless of the underlying error code, the emitted Error
// always has `code` attached and `message` is non-empty. This protects
// against accidental drops of `Object.assign(...)`-attached metadata.
// ---------------------------------------------------------------------------

describe('TunnelCluster error propagation (property)', () => {
  beforeEach(() => {
    reset()
  })

  fcTest.prop({
    code: fc.stringMatching(/^[A-Z][A-Z0-9_]{1,15}$/),
    error: fc.string({ minLength: 1, maxLength: 64 }).filter((s) => !s.includes('\n')),
  })('emitted Error always carries `code` and a non-empty `message`', ({ code, error }) => {
    const cluster = new TunnelCluster({
      remoteHost: 'tunnel-id.localtunnel.me',
      remotePort: 12345,
      localPort: 8000,
    })

    cluster.open()
    const { connectionId } = lastCreateConnectionCall()

    const onError = jest.fn()
    cluster.on('error', onError)

    fire('onConnectionError', { connectionId, error, code })

    expect(onError).toHaveBeenCalledTimes(1)
    const emitted = onError.mock.calls[0]?.[0] as Error & { code?: string }
    expect(emitted).toBeInstanceOf(Error)
    expect(emitted.code).toBe(code)
    expect(emitted.message.length).toBeGreaterThan(0)

    void cluster.close()
  })
})
