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
import { Effect, type Scope } from 'effect'
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
  readonly error: string | null
}

interface StartCall {
  readonly port: number
  readonly localOrigin: string
}

interface StartServerStub {
  readonly startServer: (
    port: number,
    localOrigin: string
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly calls: ReadonlyArray<StartCall>
  /**
   * Resolve once at least `n` calls have been observed. Subscriber-based —
   * no polling, no arbitrary settle delays. Fails if the daemon's scope
   * closes before the call count reaches `n`.
   */
  readonly awaitCalls: (n: number) => Promise<ReadonlyArray<StartCall>>
}

const WAIT_TIMEOUT_MS = 2_000

const makeFreshStore = (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `lhs-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })

const makeStartServerStub = (): StartServerStub => {
  const calls: StartCall[] = []
  const subscribers: (() => void)[] = []
  const startServer = (port: number, localOrigin: string): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      calls.push({ port, localOrigin })
      for (const fire of subscribers.splice(0, subscribers.length)) fire()
    })
  const awaitCalls = (n: number): Promise<ReadonlyArray<StartCall>> =>
    new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (calls.length >= n) {
          resolve([...calls])
          return true
        }
        return false
      }
      if (check()) return
      const timer = setTimeout(() => {
        const idx = subscribers.indexOf(fire)
        if (idx >= 0) subscribers.splice(idx, 1)
        reject(new Error(`awaitCalls(${String(n)}) — observed ${String(calls.length)}`))
      }, WAIT_TIMEOUT_MS)
      const fire = (): void => {
        if (check()) {
          clearTimeout(timer)
          return
        }
        subscribers.push(fire)
      }
      subscribers.push(fire)
    })
  return { startServer, calls, awaitCalls }
}

const waitForState = (
  store: Store<typeof schema, object>,
  predicate: (state: ServerStateValue) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<ServerStateValue> =>
  new Promise((resolve, reject) => {
    let settled = false
    // `unsubscribe` is assigned by `store.subscribe`, but the subscribe
    // callback can fire synchronously on the initial emission — before
    // the assignment lands. The indirect closure-captured holder lets
    // the callback safely call whatever's there once it exists.
    let unsubscribe: (() => void) | null = null
    const cleanup = (): void => {
      if (unsubscribe !== null) unsubscribe()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('waitForState timed out'))
    }, timeoutMs)
    unsubscribe = store.subscribe(ServerState.queries.current$, (state) => {
      if (settled) return
      if (predicate(state)) {
        settled = true
        clearTimeout(timer)
        cleanup()
        resolve(state)
      }
    })
  })

interface DaemonTestCtx {
  readonly store: Store<typeof schema, object>
  readonly calls: ReadonlyArray<StartCall>
  readonly awaitCalls: (n: number) => Promise<ReadonlyArray<StartCall>>
}

const runDaemonTest = async (
  body: (ctx: DaemonTestCtx) => Promise<void>,
  stub: StartServerStub = makeStartServerStub()
): Promise<void> => {
  const store = await makeFreshStore()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkScoped(runHttpServerDaemon(stub.startServer))
        yield* Effect.promise(() => body({ store, calls: stub.calls, awaitCalls: stub.awaitCalls }))
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
    it('should produce exactly one start call across an off→on→off cycle', () =>
      runDaemonTest(async ({ store, calls }) => {
        // The row defaults to `requestedRunning: false`. Toggling on
        // then off again forces the daemon through a full transition
        // cycle; the only legitimate start call is the toggle-on, so
        // any spurious extras from the off-transitions would already
        // be visible by the time the row settles back to
        // `requestedRunning: false, running: false`.
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 7000,
            localOrigin: 'http://127.0.0.1:7000',
          })
        )
        await waitForState(store, (s) => s.running)
        store.commit(ServerState.events.localHttpServerStateSet({ requestedRunning: false }))
        await waitForState(store, (s) => !s.running)
        // One start (the toggle-on) — the off-then-on roundtrip is the
        // signal that the daemon has run a full transition cycle.
        expect(calls).toEqual([{ port: 7000, localOrigin: 'http://127.0.0.1:7000' }])
      }))

    it('should call startServer once with the requested port and localOrigin when requestedRunning flips to true', () =>
      runDaemonTest(async ({ store, calls }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await waitForState(store, (s) => s.running)
        expect(calls).toEqual([{ port: 3000, localOrigin: 'http://127.0.0.1:3000' }])
      }))

    it('should commit running=true with the matching port and origin once the server binds', () =>
      runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 4242,
            localOrigin: 'http://127.0.0.1:4242',
          })
        )
        const state = await waitForState(store, (s) => s.running)
        expect(state).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 4242,
          localOrigin: 'http://127.0.0.1:4242',
        })
      }))

    it('should commit running=false and reset the port to the idle default when requestedRunning flips back to false', () =>
      runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 5000,
            localOrigin: 'http://127.0.0.1:5000',
          })
        )
        await waitForState(store, (s) => s.running)
        store.commit(ServerState.events.localHttpServerStateSet({ requestedRunning: false }))
        const state = await waitForState(store, (s) => !s.running)
        // Stop handler owns the port-8080 reset (formerly on the scope
        // finalizer); the user's `requestedRunning: false` is preserved.
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
      runDaemonTest(async ({ store }) => {
        // The store was created with no commits in `makeFreshStore`. If
        // the daemon did not run its initial `store.query(current$)` to
        // trigger the clientDocument's "ensure default row" path, the
        // first stream emit would fail to decode and the daemon would
        // die — which would surface as the start commit below never
        // landing. Reaching the post-bind state proves the
        // materialization worked.
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3500,
            localOrigin: 'http://127.0.0.1:3500',
          })
        )
        await waitForState(store, (s) => s.running)
        // The pre-toggle default values for the fields we didn't touch
        // survive the partial-set merge.
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 3500,
          localOrigin: 'http://127.0.0.1:3500',
          error: null,
        })
      }))
  })

  describe('reconfiguration scope teardown', () => {
    it('should keep requestedRunning=true across a port change (no finalizer cascade)', () =>
      runDaemonTest(async ({ store, calls, awaitCalls }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await awaitCalls(1)
        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await awaitCalls(2)
        // Positive observation: the daemon's post-bind commit for the
        // new config lands AFTER the reconfigure's `startServer` is
        // called, so this `waitForState` is the strict-after barrier
        // any cascade would have to fire before. If closing the old
        // sub-scope had cascaded through the scope-finalizer commits,
        // requestedRunning would have been reset to false (and the new
        // server torn down) before we observe this state.
        await waitForState(store, (s) => s.running && s.port === 4000)
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 4000,
          localOrigin: 'http://127.0.0.1:3000',
        })
        expect(calls).toEqual([
          { port: 3000, localOrigin: 'http://127.0.0.1:3000' },
          { port: 4000, localOrigin: 'http://127.0.0.1:3000' },
        ])
      }))

    it('should keep requestedRunning=true across an origin change (no finalizer cascade)', () =>
      runDaemonTest(async ({ store, calls, awaitCalls }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await awaitCalls(1)
        store.commit(
          ServerState.events.localHttpServerStateSet({ localOrigin: 'http://192.168.1.10:3000' })
        )
        await awaitCalls(2)
        await waitForState(store, (s) => s.running && s.localOrigin === 'http://192.168.1.10:3000')
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
              fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,15}$/).map((s) => `http://${s}`)
            ),
            {
              minLength: 2,
              maxLength: 5,
              selector: ([port, origin]): string => `${String(port)}|${origin}`,
            }
          ),
          (reconfigurations) =>
            runDaemonTest(async ({ store, calls, awaitCalls }) => {
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
                await awaitCalls(i + 1)
              }
              // Positive observation: the daemon's final post-bind
              // commit (matching the last requested config) is the
              // strict-after barrier any cascade-induced extra start
              // would have to fire before.
              const [lastPort, lastOrigin] = reconfigurations[reconfigurations.length - 1]
              await waitForState(
                store,
                (s) => s.running && s.port === lastPort && s.localOrigin === lastOrigin
              )
              expect(calls.length).toBe(reconfigurations.length)
              expect(calls.map((c) => [c.port, c.localOrigin])).toEqual(reconfigurations)
              expect(store.query(ServerState.queries.current$).requestedRunning).toBe(true)
            })
        ),
        { numRuns: 100 }
      ))
  })

  describe('reconfiguration mid-run', () => {
    it('should re-invoke startServer with the new port when port changes while running', () =>
      runDaemonTest(async ({ store, calls, awaitCalls }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await awaitCalls(1)
        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await awaitCalls(2)
        expect(calls.map((c) => c.port)).toEqual([3000, 4000])
      }))

    it('should re-invoke startServer with the new origin when localOrigin changes while running', () =>
      runDaemonTest(async ({ store, calls, awaitCalls }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await awaitCalls(1)
        store.commit(
          ServerState.events.localHttpServerStateSet({ localOrigin: 'http://192.168.1.10:3000' })
        )
        await awaitCalls(2)
        expect(calls.map((c) => c.localOrigin)).toEqual([
          'http://127.0.0.1:3000',
          'http://192.168.1.10:3000',
        ])
      }))
  })

  describe('long-running startServer', () => {
    /**
     * Real-world `startServer` implementations bind their listener
     * inside an `Effect.acquireRelease` block and then sit on
     * `Effect.never` until the sub-scope closes. This stub mirrors that
     * shape so the "close the previous sub-scope on reconfiguration"
     * invariant is actually exercised, rather than coincidentally true
     * because the basic stub's fiber completed immediately.
     */
    const makeLongRunningStub = (): StartServerStub & {
      readonly active: Set<string>
    } => {
      const calls: StartCall[] = []
      const active = new Set<string>()
      const subscribers: (() => void)[] = []
      const startServer = (
        port: number,
        localOrigin: string
      ): Effect.Effect<void, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const id = `${String(port)}|${localOrigin}`
            calls.push({ port, localOrigin })
            active.add(id)
            for (const fire of subscribers.splice(0, subscribers.length)) fire()
          }),
          () =>
            Effect.sync(() => {
              active.delete(`${String(port)}|${localOrigin}`)
            })
        )
      const awaitCalls = (n: number): Promise<ReadonlyArray<StartCall>> =>
        new Promise((resolve, reject) => {
          const check = (): boolean => {
            if (calls.length >= n) {
              resolve([...calls])
              return true
            }
            return false
          }
          if (check()) return
          const timer = setTimeout(() => {
            const idx = subscribers.indexOf(fire)
            if (idx >= 0) subscribers.splice(idx, 1)
            reject(new Error(`awaitCalls(${String(n)}) — observed ${String(calls.length)}`))
          }, WAIT_TIMEOUT_MS)
          const fire = (): void => {
            if (check()) {
              clearTimeout(timer)
              return
            }
            subscribers.push(fire)
          }
          subscribers.push(fire)
        })
      return { startServer, calls, awaitCalls, active }
    }

    it('releases the previous sub-scope on reconfigure (exactly one active server)', async () => {
      const stub = makeLongRunningStub()
      await runDaemonTest(async ({ store, awaitCalls }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await awaitCalls(1)
        await waitForState(store, (s) => s.running && s.port === 3000)
        expect(stub.active.size).toBe(1)

        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await awaitCalls(2)
        await waitForState(store, (s) => s.running && s.port === 4000)
        // Exactly one server is active — the previous sub-scope's
        // release fired when the daemon closed it before forking the
        // next one.
        expect(stub.active.size).toBe(1)
        expect([...stub.active]).toEqual(['4000|http://127.0.0.1:3000'])
      }, stub)
    })

    it('releases the active sub-scope when requestedRunning flips back to false', async () => {
      const stub = makeLongRunningStub()
      await runDaemonTest(async ({ store, awaitCalls }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localOrigin: 'http://127.0.0.1:3000',
          })
        )
        await awaitCalls(1)
        await waitForState(store, (s) => s.running)
        expect(stub.active.size).toBe(1)

        store.commit(ServerState.events.localHttpServerStateSet({ requestedRunning: false }))
        await waitForState(store, (s) => !s.running)
        expect(stub.active.size).toBe(0)
      }, stub)
    })
  })

  describe('error path', () => {
    const makeFailingStub = (
      failure: unknown
    ): {
      readonly startServer: (
        port: number,
        localOrigin: string
      ) => Effect.Effect<void, typeof failure, never>
      readonly calls: ReadonlyArray<StartCall>
    } => {
      const calls: StartCall[] = []
      const startServer = (
        port: number,
        localOrigin: string
      ): Effect.Effect<void, typeof failure, never> =>
        Effect.gen(function* () {
          calls.push({ port, localOrigin })
          return yield* Effect.fail(failure)
        })
      return { startServer, calls }
    }

    it('writes the failure to ServerState.error and leaves requestedRunning intact', async () => {
      const stub = makeFailingStub('boom')
      const store = await makeFreshStore()
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.forkScoped(runHttpServerDaemon(stub.startServer))
            yield* Effect.promise(async () => {
              store.commit(
                ServerState.events.localHttpServerStateSet({
                  requestedRunning: true,
                  port: 9000,
                  localOrigin: 'http://127.0.0.1:9000',
                })
              )
              const state = await waitForState(store, (s) => s.error !== null)
              expect(state.error).toMatch(/boom/)
              expect(state.running).toBe(false)
              // User's intent is preserved — the daemon does not override
              // `requestedRunning` on a startServer failure.
              expect(state.requestedRunning).toBe(true)
              expect(stub.calls).toEqual([{ port: 9000, localOrigin: 'http://127.0.0.1:9000' }])
            })
          }).pipe(Effect.scoped, Effect.provide(LocalHttpServerStore.layerFrom(store)))
        )
      } finally {
        await store.shutdownPromise().catch(() => undefined)
      }
    })

    it('recovers on a subsequent reconfigure with a healthy startServer', async () => {
      // Two-stub harness: first call fails, second succeeds. Mirrors the
      // real-world "port was busy, try a different one" loop without
      // re-mounting the daemon.
      const calls: StartCall[] = []
      const stub: StartServerStub = makeStartServerStub()
      const startServer = (
        port: number,
        localOrigin: string
      ): Effect.Effect<void, string, Scope.Scope> =>
        Effect.gen(function* () {
          calls.push({ port, localOrigin })
          if (port === 9000) return yield* Effect.fail('boom')
          return yield* stub.startServer(port, localOrigin)
        })

      const store = await makeFreshStore()
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.forkScoped(runHttpServerDaemon(startServer))
              yield* Effect.promise(async () => {
                store.commit(
                  ServerState.events.localHttpServerStateSet({
                    requestedRunning: true,
                    port: 9000,
                    localOrigin: 'http://127.0.0.1:9000',
                  })
                )
                await waitForState(store, (s) => s.error !== null)
                // Reconfigure to a port the healthy stub accepts.
                store.commit(ServerState.events.localHttpServerStateSet({ port: 9001 }))
                const state = await waitForState(store, (s) => s.running && s.port === 9001)
                expect(state.error).toBeNull()
                expect(state.requestedRunning).toBe(true)
              })
            }).pipe(Effect.provide(LocalHttpServerStore.layerFrom(store)))
          )
        )
      } finally {
        await store.shutdownPromise().catch(() => undefined)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Properties — each iteration boots a fresh in-memory livestore and the
  // daemon, so `numRuns` is intentionally small.
  // -------------------------------------------------------------------------

  describe('properties', () => {
    const PROP_OPTS = { numRuns: 100 }

    const portArb = fc.integer({ min: 1, max: 65_535 })
    // Restrict to host-like strings (no whitespace, no `/`, no control
    // chars) so the property exercises the daemon's behavior across
    // distinct origins rather than string-encoding edge cases.
    const originArb = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,31}$/).map((s) => `http://${s}`)

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
            selector: ([port, origin]): string => `${String(port)}|${origin}`,
          }),
          (reconfigurations) =>
            runDaemonTest(async ({ store, calls, awaitCalls }) => {
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
                // invocation; awaiting the call is the only signal that
                // distinguishes "user committed" from "daemon reacted".
                // oxlint-disable-next-line no-await-in-loop -- iteration must observe daemon settle before the next commit
                await awaitCalls(i + 1)
              }
              const [lastPort, lastOrigin] = reconfigurations[reconfigurations.length - 1]
              await waitForState(
                store,
                (s) => s.running && s.port === lastPort && s.localOrigin === lastOrigin
              )
              expect(calls[calls.length - 1]).toEqual({ port: lastPort, localOrigin: lastOrigin })
              expect(store.query(ServerState.queries.current$)).toMatchObject({
                running: true,
                port: lastPort,
                localOrigin: lastOrigin,
              })
            })
        ),
        PROP_OPTS
      ))
  })
})
