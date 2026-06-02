import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

// Build a controlled fake transport so the test can intercept
// `signalReady` ordering against `installConsoleInterceptor`, and
// observe what `makeWebTransport` was seeded with. Resolving / blocking
// `signalReady` is what lets the ordering test pin "interceptor
// installed before the signal-ready await."
let signalReadyResolve: (() => void) | null = null
let lastMakeWebTransportConfig: {
  readonly bridges: ReadonlyArray<{ readonly name: string }>
  readonly handlers: ReadonlyArray<Record<string, unknown>>
} | null = null
const fakeRegisterHandlers = vi.fn(() => Effect.void)
const fakeSendMessage = vi.fn(() => Effect.void)
let coordinatorConnectArg: unknown = null

vi.mock('effect-messaging-core', async () => {
  const actual = await vi.importActual<typeof import('effect-messaging-core')>(
    'effect-messaging-core'
  )
  return {
    ...actual,
    BridgeTransport: {
      ...actual.BridgeTransport,
      makeWebTransport: (config: {
        readonly bridges: ReadonlyArray<{ readonly name: string }>
        readonly handlers: ReadonlyArray<Record<string, unknown>>
      }) => {
        lastMakeWebTransportConfig = config
        return Effect.succeed({
          sendMessage: fakeSendMessage,
          enqueue: () => Effect.void,
          signalReady: Effect.async<void>((resume) => {
            signalReadyResolve = (): void => {
              resume(Effect.void)
            }
          }),
          registerHandlers: fakeRegisterHandlers,
        })
      },
    },
    Logging: {
      ...actual.Logging,
      installConsoleInterceptor: vi.fn(),
    },
  }
})

vi.mock('effect-messaging-react', async () => {
  const actual = await vi.importActual<typeof import('effect-messaging-react')>(
    'effect-messaging-react'
  )
  return {
    ...actual,
    makeHandlerCoordinator: (config: {
      readonly initial: Record<string, Record<string, unknown>>
    }) => ({
      initialHandlers: Object.values(config.initial),
      connect: (registerHandlers: unknown) => {
        coordinatorConnectArg = registerHandlers
        return { register: () => Effect.void, unregister: () => Effect.void }
      },
    }),
  }
})

// Stubbed slice factories so we can assert which bridges got seeded
// without spinning up the real gatekeeper/navigation runtimes.
const navHandlersStub = { __mark: 'nav' as const }
const gatekeeperHandlersStub = { __mark: 'gatekeeper' as const }
vi.mock('navigation-react', async () => {
  const actual =
    await vi.importActual<typeof import('navigation-react')>('navigation-react')
  return { ...actual, makeNavigationWebHandlers: () => navHandlersStub }
})
vi.mock('gatekeeper-react/web-bridge', async () => {
  const actual = await vi.importActual<typeof import('gatekeeper-react/web-bridge')>(
    'gatekeeper-react/web-bridge'
  )
  return { ...actual, makeGatekeeperWebHandlers: () => gatekeeperHandlersStub }
})

const importBuildTransport = async (): Promise<
  typeof import('./build-transport.ts').buildTransport
> => (await import('./build-transport.ts')).buildTransport

beforeEach(() => {
  lastMakeWebTransportConfig = null
  signalReadyResolve = null
  coordinatorConnectArg = null
  fakeRegisterHandlers.mockClear()
  fakeSendMessage.mockClear()
})

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('buildTransport', () => {
  test('seeds Navigation and Gatekeeper handlers and leaves slices unseeded for the coordinator', async () => {
    const buildTransport = await importBuildTransport()
    const promise = buildTransport(() => undefined)
    // Let the transport-build microtask land, then unblock signalReady.
    await Promise.resolve()
    signalReadyResolve?.()
    await promise

    expect(lastMakeWebTransportConfig).not.toBeNull()
    expect(lastMakeWebTransportConfig?.handlers).toContain(navHandlersStub)
    expect(lastMakeWebTransportConfig?.handlers).toContain(gatekeeperHandlersStub)
    // The coordinator's `initial` only seeds Navigation + Gatekeeper, so
    // the materialised handler tuple length matches that count (the
    // mock's `initialHandlers` is `Object.values(initial)`).
    expect(lastMakeWebTransportConfig?.handlers).toHaveLength(2)
  })

  test('installs the console interceptor before awaiting signalReady', async () => {
    const { Logging } = await import('effect-messaging-core')
    const interceptorMock = vi.mocked(Logging.installConsoleInterceptor)
    const buildTransport = await importBuildTransport()

    const promise = buildTransport(() => undefined)
    // Let the build microtask resolve. signalReady is still pending —
    // if the interceptor were installed *after* the await, the spy
    // would still be empty here.
    await Promise.resolve()
    await Promise.resolve()

    expect(interceptorMock).toHaveBeenCalledTimes(1)
    expect(signalReadyResolve).not.toBeNull()

    // Unblock signalReady so the returned promise can settle.
    signalReadyResolve?.()
    await promise
  })

  test('binds the coordinator to the transport.registerHandlers', async () => {
    const buildTransport = await importBuildTransport()
    const promise = buildTransport(() => undefined)
    await Promise.resolve()
    signalReadyResolve?.()
    await promise

    expect(coordinatorConnectArg).toBe(fakeRegisterHandlers)
  })
})
