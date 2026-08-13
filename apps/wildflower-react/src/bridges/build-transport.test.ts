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
// Deterministic hand-off for "the build chain reached `transport.signalReady`",
// resolved from inside the mocked `signalReady` the instant it is entered. Tests
// await this instead of polling microtasks against `signalReadyResolve`, so the
// wait no longer depends on how Effect schedules the chain's hops (micro- vs
// macrotask) — the source of the old bulk-run flakiness.
let signalReadyEntered: (() => void) | null = null
let signalReadyEnteredPromise: Promise<void> = Promise.resolve()
// The interceptor's call count captured at the instant `signalReady` is entered:
// the exact ordering point the "install before signalReady" test asserts on,
// snapshotted within this test's own chain rather than re-read live afterwards
// (a live re-read is what let an adjacent test's count bleed in under load).
let installCountAtSignalReady = -1
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
            // The source installs the interceptor immediately before awaiting
            // `signalReady`, so its count here is the ordering assertion, snapshot
            // it before handing control back to the test.
            installCountAtSignalReady = fakeInstallConsoleInterceptor.mock.calls.length
            signalReadyResolve = (): void => {
              resume(Effect.void)
            }
            signalReadyEntered?.()
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
  installCountAtSignalReady = -1
  signalReadyEnteredPromise = new Promise<void>((resolve) => {
    signalReadyEntered = resolve
  })
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

describe('buildTransport', () => {
  test('seeds Navigation and Gatekeeper handlers and leaves slices unseeded for the coordinator', async () => {
    const buildTransport = await importBuildTransport()
    const promise = buildTransport(
      () => undefined,
      () => undefined,
      () => undefined
    )
    // Resolves the instant the build chain reaches `transport.signalReady`.
    await signalReadyEnteredPromise
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
    // Resolves the instant the build chain reaches `transport.signalReady`.
    // The interceptor is installed in the same `.then` block immediately before
    // `signalReady` runs, so the count snapshotted at that entry point (within
    // this test's own chain) is exactly the ordering contract — assert on the
    // snapshot rather than re-reading the shared mock live, which could pick up
    // an adjacent test's call under load.
    await signalReadyEnteredPromise

    expect(installCountAtSignalReady).toBe(1)
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
    await signalReadyEnteredPromise
    signalReadyResolve?.()
    await promise

    expect(coordinatorConnectArg).toBe(fakeRegisterHandlers)
  })
})
