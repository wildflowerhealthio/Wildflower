import { Effect } from 'effect'

// Controllable stand-ins for the native `react-native-background-actions`
// singleton. `mock`-prefixed so babel-plugin-jest-hoist lets the factory
// close over them.
let mockRunning = true
let mockExpirationHandlers: Array<() => void> = []

jest.mock('react-native-background-actions', () => ({
  __esModule: true,
  default: {
    isRunning: () => mockRunning,
    start: jest.fn(async () => {
      mockRunning = true
    }),
    stop: jest.fn(async () => {
      mockRunning = false
    }),
    on: (_event: string, handler: () => void) => {
      mockExpirationHandlers.push(handler)
    },
    removeListener: (_event: string, handler: () => void) => {
      mockExpirationHandlers = mockExpirationHandlers.filter((entry) => entry !== handler)
    },
  },
}))

// `runServerUntilStopped` never touches these — they exist only so importing
// the module (which wires `makeServerRuntime` and the hook) doesn't pull the
// real livestore/daemon modules into the Jest VM.
jest.mock('../livestore/livestore-store.ts', () => ({
  useWildflowerStore: () => ({}),
  WildflowerStore: {},
}))
jest.mock('./http-server.ts', () => ({ HttpServerDaemonLive: {} }))
jest.mock('tunnel-expo', () => ({ TunnelDaemon: {} }))
jest.mock('tunnel-core/livestore', () => ({ TunnelStore: { layerFrom: () => ({}) } }))
jest.mock('local-http-server-core/livestore', () => ({
  LocalHttpServerStore: { layerFrom: () => ({}) },
  ServerState: { queries: { current$: {} } },
}))

import { runServerUntilStopped } from './background-server.ts'

/** Drains the microtask queue (one macrotask tick flushes pending `.then`s). */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A long-lived Effect that increments `counter.active` when it starts and
 * decrements it (incrementing `released`) when its scope closes on
 * interruption. Models the daemon launch: parks via `Effect.never`, tearing
 * down only when the fiber is interrupted.
 */
const makeCountingRuntime = (counter: {
  active: number
  released: number
}): Effect.Effect<never, never, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          counter.active += 1
        }),
        () =>
          Effect.sync(() => {
            counter.active -= 1
            counter.released += 1
          })
      )
      // Explicit `return` so the generator's return type is `never`, not
      // `void`. Without the return, `Effect.gen` infers `Effect<void, ...>`
      // because the generator function has no explicit return statement —
      // even though `Effect.never` itself is `Effect<never>`.
      return yield* Effect.never
    })
  )

beforeEach(() => {
  mockRunning = true
  mockExpirationHandlers = []
})

describe('runServerUntilStopped', () => {
  it('forks the runtime and tears it down when isRunning() goes false', async () => {
    const counter = { active: 0, released: 0 }

    const finished = runServerUntilStopped(makeCountingRuntime(counter), 5)
    await flush()
    expect(counter.active).toBe(1)

    mockRunning = false
    await finished

    expect(counter.active).toBe(0)
    expect(counter.released).toBe(1)
    // The expiration listener is detached as part of teardown.
    expect(mockExpirationHandlers).toHaveLength(0)
  })

  it('tears down on the iOS expiration event even while isRunning() stays true', async () => {
    const counter = { active: 0, released: 0 }

    // Huge poll interval so the `isRunning` path can't fire first.
    const finished = runServerUntilStopped(makeCountingRuntime(counter), 1_000_000)
    await flush()
    expect(counter.active).toBe(1)

    mockExpirationHandlers.forEach((handler) => handler())
    await finished

    expect(counter.active).toBe(0)
    expect(counter.released).toBe(1)
  })

  it('runs teardown exactly once when both stop cues fire', async () => {
    const counter = { active: 0, released: 0 }

    const finished = runServerUntilStopped(makeCountingRuntime(counter), 5)
    await flush()

    // Fire both signals; teardown must be idempotent.
    mockExpirationHandlers.forEach((handler) => handler())
    mockRunning = false
    await finished

    expect(counter.released).toBe(1)
    expect(counter.active).toBe(0)
  })
})
