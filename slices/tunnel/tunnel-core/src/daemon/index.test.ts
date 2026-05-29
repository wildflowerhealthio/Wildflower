/**
 * Tests for `runTunnelDaemon` — drives the daemon against an in-memory
 * livestore and a stubbed `startTunnel`. Stubs follow the Stream contract:
 *
 *  - `startTunnel(config)` returns a `Stream<DomainResult, E, Scope.Scope>`
 *    whose first emit is the bind signal and whose subsequent emits
 *    represent re-binds (relay handing off to a new subdomain);
 *  - the underlying `acquireRelease` keeps an `active` set in sync so
 *    reconfigure / stop invariants can be asserted;
 *  - `emitMore(result)` pushes an additional `DomainResult` into the
 *    most recent stream, exercising the multi-emit re-bind path;
 *  - `failPostBind(cause)` terminates the most recent stream with a
 *    failure, exercising the post-bind error path.
 *
 * Two stub variants:
 *
 *  - `makeStartTunnelStub` — synchronous bind: the initial `DomainResult`
 *    is offered to the queue inside `acquireRelease`'s acquire, before
 *    the consumer subscribes;
 *  - `makeDeferredBindStartTunnelStub` — async bind: the initial
 *    `DomainResult` is held behind a `Deferred` that the test releases
 *    via `stub.emitBind()` after the consumer is already subscribed.
 *    Mirrors real relays where bind is a round-trip, not a sync handoff.
 */
import { makeAdapter } from '@livestore/adapter-node'
import type { Store } from '@livestore/livestore'
import { createStorePromise, makeSchema, State } from '@livestore/livestore'
import { Deferred, Effect, Layer, LogLevel, Queue, type Scope, Stream } from 'effect'
import fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import * as LocalHttpServerLivestore from 'local-http-server-core/livestore'
import { describe, expect, it } from 'vite-plus/test'

import * as TunnelLivestore from '../livestore/index.ts'
import { type DomainResult, type ResolvedConfig, runTunnelDaemon } from './index.ts'

const { TunnelConfig, TunnelState, TunnelStore } = TunnelLivestore
const { LocalHttpServerStore, ServerState } = LocalHttpServerLivestore

/**
 * The daemon joins `TunnelConfig` (intent) with `LocalHttpServerState.port`
 * (forward target), so the test store needs both slices' tables in its
 * schema. Apps compose these the same way at the top level.
 */
const composedSchema = (() => {
  const tables = {
    ...TunnelLivestore.tables,
    ...LocalHttpServerLivestore.tables,
  }
  const events = {
    ...TunnelLivestore.events,
    ...LocalHttpServerLivestore.events,
  }
  const materializers = State.SQLite.materializers(events, {
    ...TunnelLivestore.materializers,
    ...LocalHttpServerLivestore.materializers,
  })
  return makeSchema({
    events,
    state: State.SQLite.makeState({ tables, materializers }),
  })
})()
type Schema = typeof composedSchema

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TunnelStateValue {
  readonly running: boolean
  readonly currentSubdomain: string | null
  readonly currentRootDomain: string | null
  readonly currentLocalPort: number | null
  readonly error: string | null
}

type StartTunnel<E> = (config: ResolvedConfig) => Stream.Stream<DomainResult, E, Scope.Scope>

interface StartTunnelStub<E = never> {
  readonly startTunnel: StartTunnel<E>
  readonly calls: ReadonlyArray<ResolvedConfig>
  readonly active: ReadonlySet<string>
  readonly awaitCalls: (n: number) => Promise<ReadonlyArray<ResolvedConfig>>
  /** Push an additional `DomainResult` into the most-recently-acquired stream. */
  readonly emitMore: (result: DomainResult) => Effect.Effect<void, never, never>
  /** Terminate the most-recently-acquired stream with `cause`. */
  readonly failPostBind: (cause: E) => Effect.Effect<void, never, never>
}

interface DeferredBindStartTunnelStub<E = never> extends StartTunnelStub<E> {
  /**
   * Release the gate holding back the initial bind emit on the
   * most-recently-acquired stream. Real relays bind asynchronously —
   * this lets a test exercise the path where the daemon subscribes
   * before `startTunnel` has anything to emit.
   */
  readonly emitBind: () => Effect.Effect<void, never, never>
}

const WAIT_TIMEOUT_MS = 2_000

const makeFreshStore = (): Promise<Store<Schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema: composedSchema,
    storeId: `tunnel-daemon-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    // LiveStore defaults to LogLevel.Debug in a non-production env, which
    // floods the test output with one `LiveStore shutdown complete` line per
    // store teardown (this suite creates a fresh store per property run).
    // Pin to Info to keep genuine warnings/errors visible without the noise.
    logLevel: LogLevel.Info,
  })

const configId = (c: ResolvedConfig): string =>
  `${c.subdomain}|${c.rootDomain}|${String(c.localPort)}`

const makeAwaitCalls = (
  calls: ReadonlyArray<ResolvedConfig>,
  subscribers: (() => void)[]
): ((n: number) => Promise<ReadonlyArray<ResolvedConfig>>) => {
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
  readonly queue: Queue.Queue<DomainResult>
  readonly fail: Deferred.Deferred<never, E>
}

interface DeferredEmitter<E> extends Emitter<E> {
  readonly bindGate: Deferred.Deferred<DomainResult, never>
}

interface StubOptions {
  /** Map the requested config to the granted DomainResult emitted at bind. Default: identity. */
  readonly mapToResult?: (config: ResolvedConfig) => DomainResult
}

const makeStartTunnelStub = <E = never>(opts: StubOptions = {}): StartTunnelStub<E> => {
  const calls: ResolvedConfig[] = []
  const active = new Set<string>()
  const subscribers: (() => void)[] = []
  const emitters: Emitter<E>[] = []
  const mapToResult =
    opts.mapToResult ??
    ((c: ResolvedConfig) => ({ subdomain: c.subdomain, rootDomain: c.rootDomain }))

  const startTunnel: StartTunnel<E> = (config) =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<DomainResult>()
        const fail = yield* Deferred.make<never, E>()
        const emitter: Emitter<E> = { queue, fail }
        // acquireRelease registers cleanup with whichever scope is
        // consuming the stream — for the daemon, that's `tunnelScope`,
        // so reconfigure / stop releases this tunnel's bookkeeping.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            calls.push(config)
            active.add(configId(config))
            emitters.push(emitter)
            for (const fire of subscribers.splice(0, subscribers.length)) fire()
            // Push the initial bind result so the daemon's `Stream.peel`
            // immediately observes it as the first emit.
            Effect.runSync(Queue.offer(queue, mapToResult(config)))
          }),
          () =>
            Effect.sync(() => {
              active.delete(configId(config))
              const idx = emitters.indexOf(emitter)
              if (idx >= 0) emitters.splice(idx, 1)
            })
        )
        return Stream.fromQueue(queue).pipe(Stream.interruptWhen(Deferred.await(fail)))
      })
    )

  const latest = (): Emitter<E> | undefined => emitters.at(-1)

  const emitMore = (result: DomainResult): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      const e = latest()
      if (e !== undefined) Effect.runSync(Queue.offer(e.queue, result))
    })

  const failPostBind = (cause: E): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      const e = latest()
      if (e !== undefined) Effect.runSync(Deferred.fail(e.fail, cause))
    })

  return {
    startTunnel,
    calls,
    active,
    awaitCalls: makeAwaitCalls(calls, subscribers),
    emitMore,
    failPostBind,
  }
}

/**
 * Async-bind variant: the initial `DomainResult` is held behind a
 * `Deferred` that the test must release via `emitBind()`. Models real
 * relays where bind is a round-trip; lets us prove the daemon doesn't
 * race on a sync hand-off inside `acquireRelease`'s acquire.
 */
const makeDeferredBindStartTunnelStub = <E = never>(
  opts: StubOptions = {}
): DeferredBindStartTunnelStub<E> => {
  const calls: ResolvedConfig[] = []
  const active = new Set<string>()
  const subscribers: (() => void)[] = []
  const emitters: DeferredEmitter<E>[] = []
  const mapToResult =
    opts.mapToResult ??
    ((c: ResolvedConfig) => ({ subdomain: c.subdomain, rootDomain: c.rootDomain }))

  const startTunnel: StartTunnel<E> = (config) =>
    Stream.unwrapScoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<DomainResult>()
        const fail = yield* Deferred.make<never, E>()
        const bindGate = yield* Deferred.make<DomainResult, never>()
        const emitter: DeferredEmitter<E> = { queue, fail, bindGate }
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            calls.push(config)
            active.add(configId(config))
            emitters.push(emitter)
            for (const fire of subscribers.splice(0, subscribers.length)) fire()
            // Critically, do *not* offer to the queue yet — the bind
            // emit is gated on `emitBind()`. The consumer must already
            // be subscribed by the time the result arrives, exercising
            // the async-bind path that real relays follow.
          }),
          () =>
            Effect.sync(() => {
              active.delete(configId(config))
              const idx = emitters.indexOf(emitter)
              if (idx >= 0) emitters.splice(idx, 1)
            })
        )
        // Fork: when the gate is released, forward the bound result
        // into the queue. Runs concurrently with the consumer, so the
        // consumer is guaranteed to be subscribed by the time the emit
        // arrives.
        yield* Effect.forkScoped(
          Effect.flatMap(Deferred.await(bindGate), (result) => Queue.offer(queue, result))
        )
        return Stream.fromQueue(queue).pipe(Stream.interruptWhen(Deferred.await(fail)))
      })
    )

  const latest = (): DeferredEmitter<E> | undefined => emitters.at(-1)

  const emitBind = (): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      const e = latest()
      // The latest emitter is the one whose acquire just ran. The
      // daemon may already be subscribed by the time we get here, but
      // the bind result hasn't been offered yet — release the gate.
      if (e !== undefined) {
        const config = calls.at(-1)
        if (config !== undefined) Effect.runSync(Deferred.succeed(e.bindGate, mapToResult(config)))
      }
    })

  const emitMore = (result: DomainResult): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      const e = latest()
      if (e !== undefined) Effect.runSync(Queue.offer(e.queue, result))
    })

  const failPostBind = (cause: E): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      const e = latest()
      if (e !== undefined) Effect.runSync(Deferred.fail(e.fail, cause))
    })

  return {
    startTunnel,
    calls,
    active,
    awaitCalls: makeAwaitCalls(calls, subscribers),
    emitBind,
    emitMore,
    failPostBind,
  }
}

const waitForState = (
  store: Store<Schema, object>,
  predicate: (state: TunnelStateValue) => boolean,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<TunnelStateValue> =>
  new Promise((resolve, reject) => {
    let settled = false
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
    unsubscribe = store.subscribe(TunnelState.queries.current$, (state) => {
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
  readonly store: Store<Schema, object>
}

const runDaemonTest = async <E>(
  body: (ctx: DaemonTestCtx) => Promise<void>,
  startTunnel: StartTunnel<E> = makeStartTunnelStub<E>().startTunnel
): Promise<void> => {
  const store = await makeFreshStore()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkScoped(runTunnelDaemon(startTunnel))
        yield* Effect.promise(() => body({ store }))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(TunnelStore.layerFrom(store), LocalHttpServerStore.layerFrom(store))
        )
      )
    )
  } finally {
    await store.shutdownPromise().catch(() => undefined)
  }
}

const FULL_CONFIG: ResolvedConfig = {
  subdomain: 'wildflower-expo-dev',
  rootDomain: 'loca.lt',
  localPort: 8080,
}

const commitConfig = (
  store: Store<Schema, object>,
  patch: Partial<{
    readonly subdomain: string | null
    readonly rootDomain: string | null
    readonly localPort: number | null
    readonly requestedRunning: boolean
  }>
): void => {
  store.commit(TunnelConfig.events.tunnelConfigSet(patch))
}

/**
 * Set the LHS-owned port that the tunnel daemon forwards to. Replaces
 * the legacy `TunnelConfig.localPort` knob — the daemon now joins from
 * `ServerState.port` via `resolvedConfig$`.
 */
const commitServerPort = (store: Store<Schema, object>, port: number): void => {
  store.commit(ServerState.events.localHttpServerStateSet({ port }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTunnelDaemon', () => {
  describe('start/stop lifecycle', () => {
    it('calls startTunnel with the requested config when requestedRunning flips to true', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.running)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })

    it('commits running=true plus the granted config once the tunnel opens', () =>
      runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        const state = await waitForState(store, (s) => s.running)
        expect(state).toMatchObject({
          running: true,
          currentSubdomain: FULL_CONFIG.subdomain,
          currentRootDomain: FULL_CONFIG.rootDomain,
          currentLocalPort: FULL_CONFIG.localPort,
          error: null,
        })
      }))

    it('writes the granted (not requested) subdomain when the relay redirects', () => {
      const stub = makeStartTunnelStub({
        mapToResult: () => ({ subdomain: 'fallback-sub', rootDomain: 'fallback.example.com' }),
      })
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        const state = await waitForState(store, (s) => s.running)
        expect(state).toMatchObject({
          currentSubdomain: 'fallback-sub',
          currentRootDomain: 'fallback.example.com',
          currentLocalPort: FULL_CONFIG.localPort,
        })
      }, stub.startTunnel)
    })

    it('commits running=false and clears current* fields when requestedRunning flips back to false', () =>
      runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.running)
        commitConfig(store, { requestedRunning: false })
        const state = await waitForState(store, (s) => !s.running)
        expect(state).toMatchObject({
          running: false,
          currentSubdomain: null,
          currentRootDomain: null,
          currentLocalPort: null,
          error: null,
        })
      }))

    it('produces exactly one start call across an off→on→off cycle', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.running)
        commitConfig(store, { requestedRunning: false })
        await waitForState(store, (s) => !s.running)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })

    it('handles async bind: subscribes before the relay emits, then commits running once the emit arrives', () => {
      const stub = makeDeferredBindStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        // The daemon has subscribed by the time `startTunnel`'s
        // acquire ran (awaitCalls observes the call), but no bind
        // emit has been offered yet — so `running` must still be
        // false. Settle briefly to give any racing commits a chance
        // to surface (none should).
        await stub.awaitCalls(1)
        await new Promise((r) => setTimeout(r, 50))
        const beforeBind = store.query(TunnelState.queries.current$)
        expect(beforeBind.running).toBe(false)
        // Releasing the gate lets the daemon's `Stream.peel` observe
        // the first emit and commit `running: true`.
        await Effect.runPromise(stub.emitBind())
        const state = await waitForState(store, (s) => s.running)
        expect(state).toMatchObject({
          running: true,
          currentSubdomain: FULL_CONFIG.subdomain,
          currentRootDomain: FULL_CONFIG.rootDomain,
          currentLocalPort: FULL_CONFIG.localPort,
          error: null,
        })
      }, stub.startTunnel)
    })
  })

  describe('multi-emit (relay re-bind)', () => {
    it('writes a subsequent DomainResult emit into TunnelState without re-invoking startTunnel', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.currentSubdomain === FULL_CONFIG.subdomain)
        await Effect.runPromise(
          stub.emitMore({ subdomain: 'reconnected-sub', rootDomain: 'reconnected.example.com' })
        )
        const state = await waitForState(store, (s) => s.currentSubdomain === 'reconnected-sub')
        expect(state).toMatchObject({
          running: true,
          currentSubdomain: 'reconnected-sub',
          currentRootDomain: 'reconnected.example.com',
          currentLocalPort: FULL_CONFIG.localPort,
          error: null,
        })
        // The re-bind is a within-stream event, not a new startTunnel
        // invocation — the call count must not have ticked up.
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })

    it('writes the latest granted subdomain across two consecutive re-binds (idempotent across re-emits)', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.currentSubdomain === FULL_CONFIG.subdomain)
        await Effect.runPromise(
          stub.emitMore({ subdomain: 'rebind-1', rootDomain: 'rebind-1.example.com' })
        )
        await waitForState(store, (s) => s.currentSubdomain === 'rebind-1')
        await Effect.runPromise(
          stub.emitMore({ subdomain: 'rebind-2', rootDomain: 'rebind-2.example.com' })
        )
        const state = await waitForState(store, (s) => s.currentSubdomain === 'rebind-2')
        expect(state).toMatchObject({
          running: true,
          currentSubdomain: 'rebind-2',
          currentRootDomain: 'rebind-2.example.com',
          currentLocalPort: FULL_CONFIG.localPort,
          error: null,
        })
        // Still exactly one underlying startTunnel invocation — the
        // re-binds are within-stream emits.
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })

    it('writes the re-bound subdomain then transitions to error when the stream fails post-rebind (bound state is not sticky)', () => {
      const stub = makeStartTunnelStub<string>()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.currentSubdomain === FULL_CONFIG.subdomain)
        await Effect.runPromise(
          stub.emitMore({ subdomain: 'rebind-1', rootDomain: 'rebind-1.example.com' })
        )
        // The granted subdomain must reach the store *before* the
        // failure — proves the daemon doesn't hold the bound row
        // until the stream terminates.
        await waitForState(store, (s) => s.currentSubdomain === 'rebind-1')
        await Effect.runPromise(stub.failPostBind('relay-reset-after-rebind'))
        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/relay-reset-after-rebind/)
        expect(state.running).toBe(false)
        expect(state.currentSubdomain).toBeNull()
      }, stub.startTunnel)
    })
  })

  describe('partial config', () => {
    it('stays parked until the missing fields land, then starts exactly once', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { localPort: 8080, requestedRunning: true })
        commitConfig(store, { subdomain: 'wildflower-expo-dev', rootDomain: 'loca.lt' })
        await waitForState(store, (s) => s.running)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })

    it('NoOps while subdomain/rootDomain/localPort are missing even with requestedRunning true', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        // requestedRunning flips to true with every config field still
        // null — daemon must stay parked.
        commitConfig(store, { requestedRunning: true })
        // Settle long enough that any spurious start would have shown
        // up in `stub.calls` already.
        await new Promise((r) => setTimeout(r, 50))
        expect(stub.calls).toEqual([])
        // Now seed the missing fields; the daemon should start exactly
        // once, with the full config.
        commitConfig(store, { ...FULL_CONFIG })
        await waitForState(store, (s) => s.running)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })
  })

  describe('reconfiguration mid-run', () => {
    it('re-invokes startTunnel with the new subdomain', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await stub.awaitCalls(1)
        commitConfig(store, { subdomain: 'wildflower-expo-prod' })
        await stub.awaitCalls(2)
        expect(stub.calls.map((c) => c.subdomain)).toEqual([
          'wildflower-expo-dev',
          'wildflower-expo-prod',
        ])
      }, stub.startTunnel)
    })

    it('re-invokes startTunnel when LHS state changes the forward-target port', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await stub.awaitCalls(1)
        commitServerPort(store, 9090)
        await stub.awaitCalls(2)
        expect(stub.calls.map((c) => c.localPort)).toEqual([8080, 9090])
      }, stub.startTunnel)
    })
  })

  describe('reconfiguration scope teardown', () => {
    it('releases the previous sub-scope on reconfigure (exactly one active tunnel)', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await stub.awaitCalls(1)
        await waitForState(store, (s) => s.running)
        expect(stub.active.size).toBe(1)

        commitServerPort(store, 9090)
        await stub.awaitCalls(2)
        await waitForState(store, (s) => s.currentLocalPort === 9090)
        expect(stub.active.size).toBe(1)
      }, stub.startTunnel)
    })

    it('releases the active sub-scope when requestedRunning flips back to false', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await stub.awaitCalls(1)
        await waitForState(store, (s) => s.running)
        expect(stub.active.size).toBe(1)

        commitConfig(store, { requestedRunning: false })
        await waitForState(store, (s) => !s.running)
        expect(stub.active.size).toBe(0)
      }, stub.startTunnel)
    })
  })

  describe('error path', () => {
    it('writes a pre-bind failure to TunnelState.error and leaves requestedRunning intact', async () => {
      const failingStartTunnel: StartTunnel<string> = () => Stream.fail('boom')
      let observedConfigRequested: boolean | undefined
      await runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/boom/)
        expect(state.running).toBe(false)
        observedConfigRequested = store.query(TunnelConfig.queries.current$)?.requestedRunning
      }, failingStartTunnel)
      expect(observedConfigRequested).toBe(true)
    })

    it('recovers on a reconfigure with a healthy startTunnel', async () => {
      const happy = makeStartTunnelStub<string>()
      const startTunnel: StartTunnel<string> = (config) =>
        config.localPort === 9000 ? Stream.fail('boom') : happy.startTunnel(config)
      await runDaemonTest(async ({ store }) => {
        commitServerPort(store, 9000)
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.error !== null)
        commitServerPort(store, 9001)
        const state = await waitForState(store, (s) => s.running)
        expect(state.error).toBeNull()
        expect(state.currentLocalPort).toBe(9001)
      }, startTunnel)
    })

    it('writes a post-bind failure to TunnelState.error and tears the tunnel down', async () => {
      const stub = makeStartTunnelStub<string>()
      await runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        await waitForState(store, (s) => s.running)
        expect(stub.active.size).toBe(1)

        await Effect.runPromise(stub.failPostBind('relay-reset'))

        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/relay-reset/)
        expect(state.running).toBe(false)
        expect(state.currentSubdomain).toBeNull()
        expect(stub.active.size).toBe(0)
      }, stub.startTunnel)
    })

    it('treats a stream that completes without emitting as a failed start', async () => {
      const earlyEndStartTunnel: StartTunnel<never> = () => Stream.empty
      await runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedRunning: true })
        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/ended without emitting/)
        expect(state.running).toBe(false)
      }, earlyEndStartTunnel)
    })
  })

  describe('properties', () => {
    const PROP_OPTS = { numRuns: numRunsFor(50) }
    // 50 runs × a fresh in-memory livestore + reconfigure cycle each
    // pushes the default 5 s ceiling; 30 s gives headroom for CI.
    const PROP_TIMEOUT_MS = 30_000

    const subdomainArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/)
    const portArb = fc.integer({ min: 1, max: 65_535 })

    it(
      'always forwards the requested config into startTunnel',
      () =>
        fc.assert(
          fc.asyncProperty(subdomainArb, portArb, (subdomain, localPort) => {
            const stub = makeStartTunnelStub()
            return runDaemonTest(async ({ store }) => {
              commitServerPort(store, localPort)
              commitConfig(store, {
                subdomain,
                rootDomain: 'loca.lt',
                requestedRunning: true,
              })
              await waitForState(
                store,
                (s) =>
                  s.running && s.currentSubdomain === subdomain && s.currentLocalPort === localPort
              )
              expect(stub.calls).toEqual([{ subdomain, rootDomain: 'loca.lt', localPort }])
            }, stub.startTunnel)
          }),
          PROP_OPTS
        ),
      PROP_TIMEOUT_MS
    )

    it(
      'always settles on the most recent config after a sequence of reconfigurations',
      () =>
        fc.assert(
          fc.asyncProperty(
            fc.uniqueArray(subdomainArb, { minLength: 1, maxLength: 3 }),
            (subdomains) => {
              const stub = makeStartTunnelStub()
              return runDaemonTest(async ({ store }) => {
                for (let i = 0; i < subdomains.length; i++) {
                  commitConfig(store, {
                    subdomain: subdomains[i],
                    rootDomain: 'loca.lt',
                    requestedRunning: true,
                  })
                  // oxlint-disable-next-line no-await-in-loop -- iteration must observe daemon settle before the next commit
                  await stub.awaitCalls(i + 1)
                }
                const lastSubdomain = subdomains[subdomains.length - 1]
                await waitForState(store, (s) => s.running && s.currentSubdomain === lastSubdomain)
                expect(stub.calls.length).toBe(subdomains.length)
              }, stub.startTunnel)
            }
          ),
          PROP_OPTS
        ),
      PROP_TIMEOUT_MS
    )
  })
})
