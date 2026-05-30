/**
 * Tests for `runHttpServerDaemon` — drives the daemon against an
 * in-memory livestore and a stubbed `startServer`. Stubs follow the
 * Stream contract:
 *
 *  - `startServer(port, localHostname)` returns a `Stream<void, E, Scope.Scope>`
 *    whose first emit is the bind signal;
 *  - the underlying `acquireRelease` keeps an `active` set in sync so
 *    reconfigure / stop invariants can be asserted;
 *  - `failPostBind(cause)` terminates the most recent stream with a
 *    failure, exercising the post-bind error path.
 */
import { makeAdapter } from '@livestore/adapter-node'
import type { Store } from '@livestore/livestore'
import { createStorePromise } from '@livestore/livestore'
import { Deferred, Effect, Exit, LogLevel, Queue, Stream, type Scope } from 'effect'
import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { LocalHttpServerStore, schema, ServerState } from '../livestore/index.ts'
import { runHttpServerDaemon } from './index.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ServerStateValue {
  readonly requestedRunning: boolean
  readonly running: boolean
  readonly localHostname: string
  readonly port: number
  readonly error: string | null
}

interface StartCall {
  readonly port: number
  readonly localHostname: string
}

type StartServer<E> = (config: {
  port: number
  hostname: string
}) => Stream.Stream<void, E, Scope.Scope>

interface StartServerStub<E = never> {
  readonly startServer: StartServer<E>
  readonly calls: ReadonlyArray<StartCall>
  readonly active: ReadonlySet<string>
  readonly awaitCalls: (n: number) => Promise<ReadonlyArray<StartCall>>
  /** Terminate the most-recently-acquired stream with `cause`. */
  readonly failPostBind: (cause: E) => Effect.Effect<void, never, never>
}

const WAIT_TIMEOUT_MS = 2_000

const makeFreshStore = (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `lhs-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    // LiveStore defaults to LogLevel.Debug in a non-production env, which
    // floods the test output with one `LiveStore shutdown complete` line per
    // store teardown (this suite creates a fresh store per property run).
    // Pin to Info to keep genuine warnings/errors visible without the noise.
    logLevel: LogLevel.Info,
  })

const callId = (c: StartCall): string => `${String(c.port)}|${c.localHostname}`

const makeAwaitCalls = (
  calls: ReadonlyArray<StartCall>,
  subscribers: (() => void)[]
): ((n: number) => Promise<ReadonlyArray<StartCall>>) => {
  return (n) =>
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
}

interface Emitter<E> {
  readonly queue: Queue.Queue<void>
  readonly fail: Deferred.Deferred<never, E>
}

const makeStartServerStub = <E = never>(): StartServerStub<E> => {
  const calls: StartCall[] = []
  const active = new Set<string>()
  const subscribers: (() => void)[] = []
  const emitters: Emitter<E>[] = []

  const startServer: StartServer<E> = ({ port, hostname }) =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<void>()
        const fail = yield* Deferred.make<never, E>()
        const emitter: Emitter<E> = { queue, fail }
        const call: StartCall = { port, localHostname: hostname }
        // acquireRelease registers cleanup with whichever scope is
        // consuming the stream — for the daemon, that's `serverScope`,
        // so reconfigure / stop releases this server's bookkeeping.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            calls.push(call)
            active.add(callId(call))
            emitters.push(emitter)
            for (const fire of subscribers.splice(0, subscribers.length)) fire()
            // Push the bind signal so the daemon's `Stream.peel`
            // immediately observes it as the first emit.
            Queue.unsafeOffer(queue, undefined)
          }),
          () =>
            Effect.sync(() => {
              active.delete(callId(call))
              const idx = emitters.indexOf(emitter)
              if (idx >= 0) emitters.splice(idx, 1)
            })
        )
        return Stream.fromQueue(queue).pipe(Stream.interruptWhenDeferred(fail))
      })
    )

  const failPostBind = (cause: E): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      const latest = emitters.at(-1)
      if (latest !== undefined) Deferred.unsafeDone(latest.fail, Exit.fail(cause))
    })

  return {
    startServer,
    calls,
    active,
    awaitCalls: makeAwaitCalls(calls, subscribers),
    failPostBind,
  }
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
}

const runDaemonTest = async <E>(
  body: (ctx: DaemonTestCtx) => Promise<void>,
  startServer: StartServer<E> = makeStartServerStub<E>().startServer
): Promise<void> => {
  const store = await makeFreshStore()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkScoped(runHttpServerDaemon(startServer))
        yield* Effect.promise(() => body({ store }))
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
    it('should produce exactly one start call across an off→on→off cycle', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 7000,
            localHostname: '127.0.0.1',
          })
        )
        await waitForState(store, (s) => s.running)
        store.commit(ServerState.events.localHttpServerStateSet({ requestedRunning: false }))
        await waitForState(store, (s) => !s.running)
        expect(stub.calls).toEqual([{ port: 7000, localHostname: '127.0.0.1' }])
      }, stub.startServer)
    })

    it('should call startServer once with the requested port and localHostname when requestedRunning flips to true', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await waitForState(store, (s) => s.running)
        expect(stub.calls).toEqual([{ port: 3000, localHostname: '127.0.0.1' }])
      }, stub.startServer)
    })

    it('should commit running=true with the matching port and hostname once the server binds', () =>
      runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 4242,
            localHostname: '127.0.0.1',
          })
        )
        const state = await waitForState(store, (s) => s.running)
        expect(state).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 4242,
          localHostname: '127.0.0.1',
        })
      }))

    it('should commit running=false and reset the port to the idle default when requestedRunning flips back to false', () =>
      runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 5000,
            localHostname: '127.0.0.1',
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
            localHostname: '127.0.0.1',
          })
        )
        await waitForState(store, (s) => s.running)
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 3500,
          localHostname: '127.0.0.1',
          error: null,
        })
      }))
  })

  describe('reconfiguration scope teardown', () => {
    it('should keep requestedRunning=true across a port change (no finalizer cascade)', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await stub.awaitCalls(1)
        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await stub.awaitCalls(2)
        // Positive observation: the daemon's post-bind commit for the
        // new config lands AFTER the reconfigure's `startServer` is
        // called, so this `waitForState` is the strict-after barrier
        // any cascade would have to fire before.
        await waitForState(store, (s) => s.running && s.port === 4000)
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 4000,
          localHostname: '127.0.0.1',
        })
        expect(stub.calls).toEqual([
          { port: 3000, localHostname: '127.0.0.1' },
          { port: 4000, localHostname: '127.0.0.1' },
        ])
      }, stub.startServer)
    })

    it('should keep requestedRunning=true across an hostname change (no finalizer cascade)', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await stub.awaitCalls(1)
        store.commit(ServerState.events.localHttpServerStateSet({ localHostname: '192.168.1.10' }))
        await stub.awaitCalls(2)
        await waitForState(store, (s) => s.running && s.localHostname === '192.168.1.10')
        expect(store.query(ServerState.queries.current$)).toMatchObject({
          requestedRunning: true,
          running: true,
          port: 3000,
          localHostname: '192.168.1.10',
        })
        expect(stub.calls).toEqual([
          { port: 3000, localHostname: '127.0.0.1' },
          { port: 3000, localHostname: '192.168.1.10' },
        ])
      }, stub.startServer)
    })

    it('releases the previous sub-scope on reconfigure (exactly one active server)', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await stub.awaitCalls(1)
        await waitForState(store, (s) => s.running && s.port === 3000)
        expect(stub.active.size).toBe(1)

        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await stub.awaitCalls(2)
        await waitForState(store, (s) => s.running && s.port === 4000)
        expect(stub.active.size).toBe(1)
        expect([...stub.active]).toEqual(['4000|127.0.0.1'])
      }, stub.startServer)
    })

    it('releases the active sub-scope when requestedRunning flips back to false', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await stub.awaitCalls(1)
        await waitForState(store, (s) => s.running)
        expect(stub.active.size).toBe(1)

        store.commit(ServerState.events.localHttpServerStateSet({ requestedRunning: false }))
        await waitForState(store, (s) => !s.running)
        expect(stub.active.size).toBe(0)
      }, stub.startServer)
    })
  })

  describe('reconfiguration mid-run', () => {
    it('should re-invoke startServer with the new port when port changes while running', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await stub.awaitCalls(1)
        store.commit(ServerState.events.localHttpServerStateSet({ port: 4000 }))
        await stub.awaitCalls(2)
        expect(stub.calls.map((c) => c.port)).toEqual([3000, 4000])
      }, stub.startServer)
    })

    it('should re-invoke startServer with the new hostname when localHostname changes while running', () => {
      const stub = makeStartServerStub()
      return runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await stub.awaitCalls(1)
        store.commit(ServerState.events.localHttpServerStateSet({ localHostname: '192.168.1.10' }))
        await stub.awaitCalls(2)
        expect(stub.calls.map((c) => c.localHostname)).toEqual(['127.0.0.1', '192.168.1.10'])
      }, stub.startServer)
    })
  })

  describe('error path', () => {
    it('writes a pre-bind failure to ServerState.error and leaves requestedRunning intact', async () => {
      const failingStartServer: StartServer<string> = () => Stream.fail('boom')
      let observedRequested: boolean | undefined
      await runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 9000,
            localHostname: '127.0.0.1',
          })
        )
        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/boom/)
        expect(state.running).toBe(false)
        observedRequested = state.requestedRunning
      }, failingStartServer)
      expect(observedRequested).toBe(true)
    })

    it('recovers on a subsequent reconfigure with a healthy startServer', async () => {
      const happy = makeStartServerStub<string>()
      const startServer: StartServer<string> = ({ port, hostname }) =>
        port === 9000 ? Stream.fail('boom') : happy.startServer({ port, hostname })
      await runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 9000,
            localHostname: '127.0.0.1',
          })
        )
        await waitForState(store, (s) => s.error !== null)
        store.commit(ServerState.events.localHttpServerStateSet({ port: 9001 }))
        const state = await waitForState(store, (s) => s.running && s.port === 9001)
        expect(state.error).toBeNull()
        expect(state.requestedRunning).toBe(true)
      }, startServer)
    })

    it('writes a post-bind failure to ServerState.error and tears the server down', async () => {
      const stub = makeStartServerStub<string>()
      await runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 3000,
            localHostname: '127.0.0.1',
          })
        )
        await waitForState(store, (s) => s.running)
        expect(stub.active.size).toBe(1)

        await Effect.runPromise(stub.failPostBind('crash'))

        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/crash/)
        expect(state.running).toBe(false)
        // Idle-port reset fires on the post-bind teardown too.
        expect(state.port).toBe(8080)
        expect(stub.active.size).toBe(0)
      }, stub.startServer)
    })

    it('treats a stream that completes without emitting as a failed start', async () => {
      const earlyEndStartServer: StartServer<never> = () => Stream.empty
      await runDaemonTest(async ({ store }) => {
        store.commit(
          ServerState.events.localHttpServerStateSet({
            requestedRunning: true,
            port: 9000,
            localHostname: '127.0.0.1',
          })
        )
        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/ended without emitting/)
        expect(state.running).toBe(false)
      }, earlyEndStartServer)
    })
  })

  // -------------------------------------------------------------------------
  // Properties — each iteration boots a fresh in-memory livestore and the
  // daemon, so `numRuns` is bounded by wall-clock budget.
  // -------------------------------------------------------------------------

  describe('properties', () => {
    const PROP_OPTS = { numRuns: numRunsFor({ base: 50 }) }
    // 50 runs × a fresh in-memory livestore + reconfigure cycle each
    // pushes the default 5 s ceiling; 30 s gives headroom for CI.
    const PROP_TIMEOUT_MS = 30_000

    const portArb = fc.integer({ min: 1, max: 65_535 })
    // Restrict to host-like strings (no whitespace, no `/`, no control
    // chars) so the property exercises the daemon's behavior across
    // distinct hostnames rather than string-encoding edge cases.
    const hostnameArb = fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,31}$/)

    it(
      'should always forward the requested port and hostname into startServer',
      () =>
        fc.assert(
          fc.asyncProperty(portArb, hostnameArb, (port, hostname) => {
            const stub = makeStartServerStub()
            return runDaemonTest(async ({ store }) => {
              store.commit(
                ServerState.events.localHttpServerStateSet({
                  requestedRunning: true,
                  port,
                  localHostname: hostname,
                })
              )
              await waitForState(
                store,
                (s) => s.running && s.port === port && s.localHostname === hostname
              )
              expect(stub.calls).toEqual([{ port, localHostname: hostname }])
            }, stub.startServer)
          }),
          PROP_OPTS
        ),
      PROP_TIMEOUT_MS
    )

    it(
      'should always end with running=false after requestedRunning is flipped back to false',
      () =>
        fc.assert(
          fc.asyncProperty(portArb, hostnameArb, (port, hostname) =>
            runDaemonTest(async ({ store }) => {
              store.commit(
                ServerState.events.localHttpServerStateSet({
                  requestedRunning: true,
                  port,
                  localHostname: hostname,
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
        ),
      PROP_TIMEOUT_MS
    )

    it(
      'should always settle on the most recent (port, hostname) after a sequence of reconfigurations',
      () =>
        fc.assert(
          fc.asyncProperty(
            fc.uniqueArray(fc.tuple(portArb, hostnameArb), {
              minLength: 1,
              maxLength: 4,
              selector: ([port, hostname]): string => `${String(port)}|${hostname}`,
            }),
            (reconfigurations) => {
              const stub = makeStartServerStub()
              return runDaemonTest(async ({ store }) => {
                for (let i = 0; i < reconfigurations.length; i++) {
                  const [port, hostname] = reconfigurations[i]
                  store.commit(
                    ServerState.events.localHttpServerStateSet({
                      requestedRunning: true,
                      port,
                      localHostname: hostname,
                    })
                  )
                  // oxlint-disable-next-line no-await-in-loop -- iteration must observe daemon settle before the next commit
                  await stub.awaitCalls(i + 1)
                }
                const [lastPort, lastHostname] = reconfigurations[reconfigurations.length - 1]
                await waitForState(
                  store,
                  (s) => s.running && s.port === lastPort && s.localHostname === lastHostname
                )
                expect(stub.calls[stub.calls.length - 1]).toEqual({
                  port: lastPort,
                  localHostname: lastHostname,
                })
                expect(store.query(ServerState.queries.current$)).toMatchObject({
                  running: true,
                  port: lastPort,
                  localHostname: lastHostname,
                })
              }, stub.startServer)
            }
          ),
          PROP_OPTS
        ),
      PROP_TIMEOUT_MS
    )
  })
})
