/**
 * Tests for `runHttpServerDaemon` — verifies the daemon's reaction to
 * `LocalHttpServerStore.requestedRunning` transitions against an in-memory
 * livestore plus a stubbed `startServer`. The stub succeeds with `void` to
 * signal "bound" (the same signal the daemon's `Effect.tap` watches for) and
 * is forked by the daemon into a sub-scope per server.
 */
import { makeAdapter } from '@livestore/adapter-node'
import type { Store } from '@livestore/livestore'
import { createStorePromise } from '@livestore/livestore'
import { Effect } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { LocalHttpServerStore, schema, ServerState } from '../livestore/index.ts'
import { runHttpServerDaemon } from './index.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ServerStateValue {
  readonly requestedRunning: boolean
  readonly running: boolean
  readonly localOrigin: string
  readonly port: number
}

interface StartCall {
  readonly port: number
  readonly localOrigin: string
}

const WAIT_TIMEOUT_MS = 2_000

const makeFreshStore = (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `lhs-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })

const makeStartServerStub = (): {
  readonly startServer: (port: number, localOrigin: string) => Effect.Effect<void, never, never>
  readonly calls: ReadonlyArray<StartCall>
} => {
  const calls: StartCall[] = []
  const startServer = (port: number, localOrigin: string): Effect.Effect<void, never, never> => {
    calls.push({ port, localOrigin })
    return Effect.void
  }
  return { startServer, calls }
}

const waitForState = (
  store: Store<typeof schema, object>,
  predicate: (state: ServerStateValue) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<ServerStateValue> =>
  new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      unsubscribe()
      reject(new Error('waitForState timed out'))
    }, timeoutMs)
    const unsubscribe = store.subscribe(ServerState.queries.current$, (state) => {
      if (settled) return
      if (predicate(state)) {
        settled = true
        clearTimeout(timer)
        unsubscribe()
        resolve(state)
      }
    })
  })

/**
 * Wait until the calls array satisfies `predicate`. Used after a
 * reconfiguration commit, where the store state alone can't distinguish
 * "user just changed port" from "daemon picked up the change" (the daemon's
 * own commit doesn't introduce new fields to wait on).
 */
const waitForCalls = (
  calls: ReadonlyArray<StartCall>,
  predicate: (calls: ReadonlyArray<StartCall>) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<ReadonlyArray<StartCall>> =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate(calls)) {
        resolve(calls)
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitForCalls timed out'))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })

const runDaemonTest = async (
  body: (ctx: {
    readonly store: Store<typeof schema, object>
    readonly calls: ReadonlyArray<StartCall>
  }) => Promise<void>
): Promise<void> => {
  const store = await makeFreshStore()
  const { startServer, calls } = makeStartServerStub()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkScoped(runHttpServerDaemon(startServer))
        yield* Effect.promise(() => body({ store, calls }))
      }).pipe(Effect.scoped, Effect.provide(LocalHttpServerStore.layerFrom(store)))
    )
  } finally {
    await store.shutdownPromise().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHttpServerDaemon', () => {
  describe('start/stop lifecycle', () => {
    it('should not call startServer while requestedRunning stays false', () =>
      runDaemonTest(async ({ store, calls }) => {
        // Arrange — defaults committed by the schema (requestedRunning=false).
        // Act — let the daemon subscribe and drain the initial state.
        await new Promise((resolve) => setTimeout(resolve, 50))
        // Assert
        expect(calls).toEqual([])
        expect(store.query(ServerState.queries.current$).running).toBe(false)
      }))

    it('should call startServer once with the requested port and localOrigin when requestedRunning flips to true', () =>
      runDaemonTest(async ({ store, calls }) => {
        // Act
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await waitForState(store, (s) => s.running)
        // Assert
        expect(calls).toEqual([{ port: 3000, localOrigin: 'http://127.0.0.1:3000' }])
      }))

    it('should commit running=true with the matching port and origin once the server binds', () =>
      runDaemonTest(async ({ store }) => {
        // Act
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 4242,
            localOrigin: 'http://127.0.0.1:4242',
          })
        )
        const state = await waitForState(store, (s) => s.running)
        // Assert
        expect(state).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 4242,
          localOrigin: 'http://127.0.0.1:4242',
        })
      }))

    it('should commit running=false and reset the port to the idle default when requestedRunning flips back to false', () =>
      runDaemonTest(async ({ store }) => {
        // Arrange
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 5000,
            localOrigin: 'http://127.0.0.1:5000',
          })
        )
        await waitForState(store, (s) => s.running)
        // Act
        store.commit(ServerState.events.localHttpServerStateSet({ requestedRunning: false }))
        const state = await waitForState(store, (s) => !s.running)
        // Assert — stop handler owns the port-8080 reset (formerly on the
        // scope finalizer); the user's `requestedRunning: false` is preserved.
        expect(state).toMatchObject({ requestedRunning: false, running: false, port: 8080 })
      }))
  })

  // -------------------------------------------------------------------------
  // Properties that verify the three daemon fixes:
  //   1. `startServer: Effect<void, E, never>` — the test stub here returns
  //      plain `Effect.void` with no cast. If the daemon's success type ever
  //      narrows back to `never`, the stub will stop type-checking.
  //   2. The daemon materializes the clientDocument's default row on startup
  //      via an initial synchronous `store.query`, so tests can boot a fresh
  //      store without pre-committing defaults.
  //   3. Reconfiguration closes the previous sub-scope before forking the
  //      next one — and the state-reset commits live at the daemon's
  //      transition sites, not on the sub-scope finalizer, so closing the
  //      old scope does not cascade through the stream watcher.
  // -------------------------------------------------------------------------

  describe('default-row materialization on startup', () => {
    it('should materialize the clientDocument default row without any prior commit', () =>
      runDaemonTest(async ({ store, calls }) => {
        // The store was created with no commits in `makeFreshStore`. If
        // the daemon did not run its initial `store.query(current$)` to
        // trigger the clientDocument's "ensure default row" path, the
        // first stream emit would fail to decode and the daemon would
        // die. Reaching this assertion means the materialization worked.
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: false,
          running: false,
          port: 8080,
          localOrigin: 'http://127.0.0.1:8080',
        })
        expect(calls).toEqual([])
      }))
  })

  describe('reconfiguration scope teardown', () => {
    it('should keep requestedRunning=true across a port change (no finalizer cascade)', () =>
      runDaemonTest(async ({ store, calls }) => {
        // Arrange — running on 3000.
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await waitForCalls(calls, (c) => c.length >= 1)
        // Act — reconfigure to 4000.
        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await waitForCalls(calls, (c) => c.length >= 2)
        // Settle: give any cascade a chance to fire before asserting.
        await new Promise((resolve) => setTimeout(resolve, 50))
        // Assert — if closing the old sub-scope had cascaded through the
        // scope-finalizer commits, requestedRunning would have been reset
        // to false (and the new server torn down). Both must survive.
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 4000,
          localOrigin: 'http://127.0.0.1:3000',
        })
        // No spurious extra start invocations either.
        expect(calls).toEqual([
          { port: 3000, localOrigin: 'http://127.0.0.1:3000' },
          { port: 4000, localOrigin: 'http://127.0.0.1:3000' },
        ])
      }))

    it('should keep requestedRunning=true across an origin change (no finalizer cascade)', () =>
      runDaemonTest(async ({ store, calls }) => {
        // Arrange — running on the loopback origin.
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await waitForCalls(calls, (c) => c.length >= 1)
        // Act — change only the origin.
        store.commit(
          ServerState.events.localHttpServerStateSet({ localOrigin: 'http://192.168.1.10:3000' })
        )
        await waitForCalls(calls, (c) => c.length >= 2)
        await new Promise((resolve) => setTimeout(resolve, 50))
        // Assert
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 3000,
          localOrigin: 'http://192.168.1.10:3000',
        })
        expect(calls).toEqual([
          { port: 3000, localOrigin: 'http://127.0.0.1:3000' },
          { port: 3000, localOrigin: 'http://192.168.1.10:3000' },
        ])
      }))

    it('should call startServer exactly once per distinct (port, origin) across N reconfigurations', () =>
      fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(
            fc.tuple(
              fc.integer({ min: 1, max: 65_535 }),
              fc.string({ minLength: 1, maxLength: 16 }).map((s) => `http://${s}`)
            ),
            {
              minLength: 2,
              maxLength: 5,
              selector: ([port, origin]): string => `${port}|${origin}`,
            }
          ),
          (reconfigurations) =>
            runDaemonTest(async ({ store, calls }) => {
              for (let i = 0; i < reconfigurations.length; i++) {
                const [port, origin] = reconfigurations[i]
                store.commit(
                  ServerState.events.localHttpServerStateSet({
                    requestedRunning: true,
                    port,
                    localOrigin: origin,
                  })
                )
                // oxlint-disable-next-line no-await-in-loop -- iteration must observe daemon settle before the next commit
                await waitForCalls(calls, (c) => c.length >= i + 1)
              }
              // Settle: give a chance for any spurious extra start (from a
              // hypothetical cascade) to land before we assert the count.
              await new Promise((resolve) => setTimeout(resolve, 50))
              // Each distinct (port, origin) is exactly one start. If the
              // old sub-scope's finalizer had cascaded, we would see a
              // tail of extra starts and stops.
              expect(calls.length).toBe(reconfigurations.length)
              expect(calls.map((c) => [c.port, c.localOrigin])).toEqual(reconfigurations)
              // And the user's intent survives the whole sequence.
              expect(store.query(ServerState.queries.current$).requestedRunning).toBe(true)
            })
        ),
        { numRuns: 8 }
      ))
  })

  describe('reconfiguration mid-run', () => {
    it('should re-invoke startServer with the new port when port changes while running', () =>
      runDaemonTest(async ({ store, calls }) => {
        // Arrange — running on 3000.
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await waitForCalls(calls, (c) => c.length >= 1)
        // Act — request port 4000.
        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await waitForCalls(calls, (c) => c.length >= 2)
        // Assert — startServer was re-invoked for the new port.
        expect(calls.map((c) => c.port)).toEqual([3000, 4000])
      }))

    it('should re-invoke startServer with the new origin when localOrigin changes while running', () =>
      runDaemonTest(async ({ store, calls }) => {
        // Arrange — running on the loopback origin.
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await waitForCalls(calls, (c) => c.length >= 1)
        // Act — change only the origin.
        store.commit(
          ServerState.events.localHttpServerStateSet({ localOrigin: 'http://192.168.1.10:3000' })
        )
        await waitForCalls(calls, (c) => c.length >= 2)
        // Assert
        expect(calls.map((c) => c.localOrigin)).toEqual([
          'http://127.0.0.1:3000',
          'http://192.168.1.10:3000',
        ])
      }))
  })

  // -------------------------------------------------------------------------
  // Properties — each iteration boots a fresh in-memory livestore and the
  // daemon, so `numRuns` is intentionally small.
  // -------------------------------------------------------------------------

  describe('properties', () => {
    const PROP_OPTS = { numRuns: 8 }

    const portArb = fc.integer({ min: 1, max: 65_535 })
    const originArb = fc.string({ minLength: 1, maxLength: 32 }).map((s) => `http://${s}`)

    it('should always forward the requested port and origin into startServer', () =>
      fc.assert(
        fc.asyncProperty(portArb, originArb, (port, origin) =>
          runDaemonTest(async ({ store, calls }) => {
            store.commit(
              ServerState.events.localHttpServerStateSet({
                requestedRunning: true,
                port,
                localOrigin: origin,
              })
            )
            await waitForState(
              store,
              (s) => s.running && s.port === port && s.localOrigin === origin
            )
            expect(calls).toEqual([{ port, localOrigin: origin }])
          })
        ),
        PROP_OPTS
      ))

    it('should always end with running=false after requestedRunning is flipped back to false', () =>
      fc.assert(
        fc.asyncProperty(portArb, originArb, (port, origin) =>
          runDaemonTest(async ({ store }) => {
            store.commit(
              ServerState.events.localHttpServerStateSet({
                requestedRunning: true,
                port,
                localOrigin: origin,
              })
            )
            await waitForState(store, (s) => s.running)
            store.commit(ServerState.events.localHttpServerStateSet({ requestedRunning: false }))
            const state = await waitForState(store, (s) => !s.running)
            expect(state.running).toBe(false)
            expect(state.requestedRunning).toBe(false)
          })
        ),
        PROP_OPTS
      ))

    it('should always settle on the most recent (port, origin) after a sequence of reconfigurations', () =>
      fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.tuple(portArb, originArb), {
            minLength: 1,
            maxLength: 4,
            selector: ([port, origin]): string => `${port}|${origin}`,
          }),
          (reconfigurations) =>
            runDaemonTest(async ({ store, calls }) => {
              for (let i = 0; i < reconfigurations.length; i++) {
                const [port, origin] = reconfigurations[i]
                store.commit(
                  ServerState.events.localHttpServerStateSet({
                    requestedRunning: true,
                    port,
                    localOrigin: origin,
                  })
                )
                // Each unique (port, origin) tuple forces a new startServer
                // invocation; waiting on the calls count is the only signal
                // that distinguishes "user committed" from "daemon reacted".
                // oxlint-disable-next-line no-await-in-loop -- iteration must observe daemon settle before the next commit
                await waitForCalls(calls, (c) => c.length >= i + 1)
              }
              const last = reconfigurations[reconfigurations.length - 1]
              expect(calls[calls.length - 1]).toEqual({ port: last[0], localOrigin: last[1] })
              expect(store.query(ServerState.queries.current$)).toMatchObject({
                running: true,
                port: last[0],
                localOrigin: last[1],
              })
            })
        ),
        PROP_OPTS
      ))
  })
})
