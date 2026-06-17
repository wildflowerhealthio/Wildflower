import { Effect, Layer } from 'effect'
import type * as EffectMessagingCore from 'effect-messaging-core'
import type * as EffectMessagingReact from 'effect-messaging-react'
import type * as GatekeeperWebBridge from 'gatekeeper-react/web-bridge'
import type * as NavigationReact from 'navigation-react'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import type { buildTransport as BuildTransportFn } from './build-transport.ts'

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
const fakeInstallConsoleInterceptor = vi.fn()
// `buildTransport` provides the telemetry tracer layer so the
// transport's forked dispatch fiber inherits it. The real
// `webTelemetryLayerFromEnv` installs a global OTel context manager and
// inits Sentry as an eager side effect; stub it to a no-op `Layer.empty`
// so this focused wiring test stays deterministic and side-effect-free.
const fakeWebTelemetryLayer = vi.fn(() => Layer.empty)
let coordinatorConnectArg: unknown = null

vi.mock('effect-messaging-core', async () => {
  const actual = await vi.importActual<typeof EffectMessagingCore>('effect-messaging-core')
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
      installConsoleInterceptor: fakeInstallConsoleInterceptor,
    },
  }
})

vi.mock('effect-messaging-react', async () => {
  const actual = await vi.importActual<typeof EffectMessagingReact>('effect-messaging-react')
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
  const actual = await vi.importActual<typeof NavigationReact>('navigation-react')
  return { ...actual, makeNavigationWebHandlers: () => navHandlersStub }
})
vi.mock('gatekeeper-react/web-bridge', async () => {
  const actual = await vi.importActual<typeof GatekeeperWebBridge>('gatekeeper-react/web-bridge')
  return { ...actual, makeGatekeeperWebHandlers: () => gatekeeperHandlersStub }
})
vi.mock('telemetry-web', async () => {
  const actual = await vi.importActual<typeof TelemetryWeb>('telemetry-web')
  return { ...actual, webTelemetryLayerFromEnv: fakeWebTelemetryLayer }
})

const importBuildTransport = async (): Promise<typeof BuildTransportFn> =>
  (await import('./build-transport.ts')).buildTransport

beforeEach(() => {
  lastMakeWebTransportConfig = null
  signalReadyResolve = null
  coordinatorConnectArg = null
  fakeRegisterHandlers.mockClear()
  fakeSendMessage.mockClear()
  fakeInstallConsoleInterceptor.mockClear()
  fakeWebTelemetryLayer.mockClear()
})

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

// Poll across microtasks until `predicate()` returns true or the
// budget is exhausted. The build chain is `runPromise → .then →
// runPromise(signalReady)` — multiple microtask hops — so a fixed
// `await Promise.resolve()` count races the chain. Polling makes the
// wait insensitive to the exact hop count without bringing in real
// timers.
const waitForMicrotask = async (predicate: () => boolean, budget = 50): Promise<void> => {
  for (let i = 0; i < budget; i++) {
    if (predicate()) return
    // oxlint-disable-next-line no-await-in-loop -- polling each microtask tick
    await Promise.resolve()
  }
}

describe('buildTransport', () => {
  test('seeds Navigation and Gatekeeper handlers and leaves slices unseeded for the coordinator', async () => {
    const buildTransport = await importBuildTransport()
    const promise = buildTransport(
      () => undefined,
      () => undefined,
      () => undefined
    )
    // The build chain hops through several microtasks before
    // `transport.signalReady` runs and our mock sets `signalReadyResolve`.
    await waitForMicrotask(() => signalReadyResolve !== null)
    signalReadyResolve?.()
    await promise

    expect(lastMakeWebTransportConfig).not.toBeNull()
    // The telemetry tracer layer is provided to the transport build so the
    // forked dispatch fiber inherits the OTel tracer.
    expect(fakeWebTelemetryLayer).toHaveBeenCalled()
    expect(lastMakeWebTransportConfig?.handlers).toContain(navHandlersStub)
    expect(lastMakeWebTransportConfig?.handlers).toContain(gatekeeperHandlersStub)
    // The coordinator's `initial` only seeds Navigation + Gatekeeper, so
    // the materialised handler tuple length matches that count (the
    // mock's `initialHandlers` is `Object.values(initial)`).
    expect(lastMakeWebTransportConfig?.handlers).toHaveLength(2)
  })

  test('installs the console interceptor before awaiting signalReady', async () => {
    const buildTransport = await importBuildTransport()

    const promise = buildTransport(
      () => undefined,
      () => undefined,
      () => undefined
    )
    // Wait until the build chain has reached `transport.signalReady`
    // (which fires our mock's `Effect.async` and sets `signalReadyResolve`).
    // The interceptor is installed in the same `.then` block immediately
    // before `signalReady` runs, so by this point it must have fired —
    // if it hadn't, the ordering contract would be broken.
    await waitForMicrotask(() => signalReadyResolve !== null)

    expect(fakeInstallConsoleInterceptor).toHaveBeenCalledTimes(1)
    expect(signalReadyResolve).not.toBeNull()

    // Unblock signalReady so the returned promise can settle.
    signalReadyResolve?.()
    await promise
  })

  test('binds the coordinator to the transport.registerHandlers', async () => {
    const buildTransport = await importBuildTransport()
    const promise = buildTransport(
      () => undefined,
      () => undefined,
      () => undefined
    )
    await waitForMicrotask(() => signalReadyResolve !== null)
    signalReadyResolve?.()
    await promise

    expect(coordinatorConnectArg).toBe(fakeRegisterHandlers)
  })
})
