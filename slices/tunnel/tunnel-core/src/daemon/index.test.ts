/**
 * Tests for `runTunnelDaemon` — drives the daemon against an in-memory
 * livestore and a stubbed `startTunnel`. Stubs follow the new contract:
 *
 *  - `startTunnel(config, setBindResult)` parks until interrupted, calling
 *    `setBindResult` to mark bind (the daemon awaits that callback's
 *    Deferred to detect "tunnel up");
 *  - the `acquireRelease` keeps an `active` set in sync so reconfigure /
 *    stop invariants can be asserted;
 *  - an optional `failPostBind` knob makes the stub fail *after* bind so
 *    the post-bind error path can be exercised.
 */
import { makeAdapter } from '@livestore/adapter-node'
import type { Store } from '@livestore/livestore'
import { createStorePromise } from '@livestore/livestore'
import { Deferred, Effect, type Scope } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { schema, TunnelConfig, TunnelState, TunnelStore } from '../livestore/index.ts'
import { type DomainResult, type ResolvedConfig, runTunnelDaemon } from './index.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TunnelStateValue {
  readonly currentEnabled: boolean
  readonly currentSubdomain: string | null
  readonly currentRootDomain: string | null
  readonly currentLocalPort: number | null
  readonly error: string | null
}

type StartTunnel<E> = (
  config: ResolvedConfig,
  setBindResult: (result: DomainResult) => Effect.Effect<void, never, never>
) => Effect.Effect<never, E, Scope.Scope>

interface StartTunnelStub<E = never> {
  readonly startTunnel: StartTunnel<E>
  readonly calls: ReadonlyArray<ResolvedConfig>
  readonly active: ReadonlySet<string>
  readonly awaitCalls: (n: number) => Promise<ReadonlyArray<ResolvedConfig>>
  readonly failPostBind: (cause: E) => Effect.Effect<void, never, never>
}

const WAIT_TIMEOUT_MS = 2_000

const makeFreshStore = (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `tunnel-daemon-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

interface StubOptions<E> {
  /** Map the requested config to the granted DomainResult. Default: identity. */
  readonly mapToResult?: (config: ResolvedConfig) => DomainResult
  /** Optional post-bind failure trigger; if omitted, the stub never fails post-bind. */
  // included via failPostBind on the returned StartTunnelStub regardless
  // (caller decides whether to fire it) — this field is just for type plumbing.
  readonly _phantomE?: E
}

const makeStartTunnelStub = <E = never>(opts: StubOptions<E> = {}): StartTunnelStub<E> => {
  const calls: ResolvedConfig[] = []
  const active = new Set<string>()
  const subscribers: (() => void)[] = []
  const failures: Deferred.Deferred<never, E>[] = []
  const mapToResult =
    opts.mapToResult ??
    ((c: ResolvedConfig) => ({ subdomain: c.subdomain, rootDomain: c.rootDomain }))

  const startTunnel: StartTunnel<E> = (config, setBindResult) =>
    Effect.acquireRelease(
      // Acquire: register the tunnel, signal bind, allocate the
      // post-bind failure Deferred so `failPostBind` can target this
      // running instance.
      Effect.gen(function* () {
        calls.push(config)
        active.add(configId(config))
        for (const fire of subscribers.splice(0, subscribers.length)) fire()
        yield* setBindResult(mapToResult(config))
        const fail = yield* Deferred.make<never, E>()
        failures.push(fail)
        return fail
      }),
      (fail) =>
        Effect.sync(() => {
          active.delete(configId(config))
          const idx = failures.indexOf(fail)
          if (idx >= 0) failures.splice(idx, 1)
        })
    ).pipe(Effect.flatMap((fail) => Deferred.await(fail)))

  const failPostBind = (cause: E): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      // Fail the most recently-bound live tunnel — there's only one
      // live at a time given the daemon's invariants, but if the test
      // changes that, we fail the newest.
      const latest = failures.at(-1)
      if (latest !== undefined) {
        Effect.runSync(Deferred.fail(latest, cause))
      }
    })

  return {
    startTunnel,
    calls,
    active,
    awaitCalls: makeAwaitCalls(calls, subscribers),
    failPostBind,
  }
}

const waitForState = (
  store: Store<typeof schema, object>,
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
  readonly store: Store<typeof schema, object>
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
      }).pipe(Effect.scoped, Effect.provide(TunnelStore.layerFrom(store)))
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
  store: Store<typeof schema, object>,
  patch: Partial<{
    readonly subdomain: string | null
    readonly rootDomain: string | null
    readonly localPort: number | null
    readonly requestedEnabled: boolean
  }>
): void => {
  store.commit(TunnelConfig.events.tunnelConfigSet(patch))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTunnelDaemon', () => {
  describe('start/stop lifecycle', () => {
    it('calls startTunnel with the requested config when requestedEnabled flips to true', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })

    it('commits currentEnabled=true plus the granted config once the tunnel opens', () =>
      runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        const state = await waitForState(store, (s) => s.currentEnabled)
        expect(state).toMatchObject({
          currentEnabled: true,
          currentSubdomain: FULL_CONFIG.subdomain,
          currentRootDomain: FULL_CONFIG.rootDomain,
          currentLocalPort: FULL_CONFIG.localPort,
          error: null,
        })
      }))

    it('writes the granted (not requested) subdomain when the relay redirects', () => {
      // The relay grants a different subdomain and rootDomain than
      // requested. Asserting on the granted values pins the daemon to
      // `DomainResult` rather than echoing the request.
      const stub = makeStartTunnelStub({
        mapToResult: () => ({ subdomain: 'fallback-sub', rootDomain: 'fallback.example.com' }),
      })
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        const state = await waitForState(store, (s) => s.currentEnabled)
        expect(state).toMatchObject({
          currentSubdomain: 'fallback-sub',
          currentRootDomain: 'fallback.example.com',
          // localPort is purely local, so it carries through from the request.
          currentLocalPort: FULL_CONFIG.localPort,
        })
      }, stub.startTunnel)
    })

    it('commits currentEnabled=false and clears current* fields when requestedEnabled flips back to false', () =>
      runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await waitForState(store, (s) => s.currentEnabled)
        commitConfig(store, { requestedEnabled: false })
        const state = await waitForState(store, (s) => !s.currentEnabled)
        expect(state).toMatchObject({
          currentEnabled: false,
          currentSubdomain: null,
          currentRootDomain: null,
          currentLocalPort: null,
          error: null,
        })
      }))

    it('produces exactly one start call across an off→on→off cycle', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await waitForState(store, (s) => s.currentEnabled)
        commitConfig(store, { requestedEnabled: false })
        await waitForState(store, (s) => !s.currentEnabled)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })
  })

  describe('partial config', () => {
    it('stays parked until the missing fields land, then starts exactly once', () => {
      // Deterministic happens-after: after committing the partial
      // (incomplete) config, commit a *complete* config and assert
      // exactly one call was observed. A spurious tick from the partial
      // commit would surface as a second entry in `calls`.
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { localPort: 8080, requestedEnabled: true })
        commitConfig(store, { subdomain: 'wildflower-expo-dev', rootDomain: 'loca.lt' })
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })

    it('NoOps when all of subdomain/rootDomain/localPort are missing even with requestedEnabled true', () => {
      // Marker-based happens-after: commit a partial config that should
      // NoOp, then commit a complete config and wait for it to start.
      // If the partial commit had spuriously started, `stub.calls`
      // would carry two entries.
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { requestedEnabled: true })
        commitConfig(store, { ...FULL_CONFIG })
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.calls).toEqual([FULL_CONFIG])
      }, stub.startTunnel)
    })
  })

  describe('reconfiguration mid-run', () => {
    it('re-invokes startTunnel with the new subdomain', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await stub.awaitCalls(1)
        commitConfig(store, { subdomain: 'wildflower-expo-prod' })
        await stub.awaitCalls(2)
        expect(stub.calls.map((c) => c.subdomain)).toEqual([
          'wildflower-expo-dev',
          'wildflower-expo-prod',
        ])
      }, stub.startTunnel)
    })

    it('re-invokes startTunnel with the new local port', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await stub.awaitCalls(1)
        commitConfig(store, { localPort: 9090 })
        await stub.awaitCalls(2)
        expect(stub.calls.map((c) => c.localPort)).toEqual([8080, 9090])
      }, stub.startTunnel)
    })
  })

  describe('reconfiguration scope teardown', () => {
    it('releases the previous sub-scope on reconfigure (exactly one active tunnel)', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await stub.awaitCalls(1)
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.active.size).toBe(1)

        commitConfig(store, { localPort: 9090 })
        await stub.awaitCalls(2)
        await waitForState(store, (s) => s.currentLocalPort === 9090)
        expect(stub.active.size).toBe(1)
      }, stub.startTunnel)
    })

    it('releases the active sub-scope when requestedEnabled flips back to false', () => {
      const stub = makeStartTunnelStub()
      return runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await stub.awaitCalls(1)
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.active.size).toBe(1)

        commitConfig(store, { requestedEnabled: false })
        await waitForState(store, (s) => !s.currentEnabled)
        expect(stub.active.size).toBe(0)
      }, stub.startTunnel)
    })
  })

  describe('error path', () => {
    it('writes a pre-bind failure to TunnelState.error and leaves requestedEnabled intact', async () => {
      const failingStartTunnel: StartTunnel<string> = () => Effect.fail('boom')
      let observedConfigRequested: boolean | undefined
      await runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/boom/)
        expect(state.currentEnabled).toBe(false)
        observedConfigRequested = store.query(TunnelConfig.queries.current$)?.requestedEnabled
      }, failingStartTunnel)
      expect(observedConfigRequested).toBe(true)
    })

    it('recovers on a reconfigure with a healthy startTunnel', async () => {
      const happy = makeStartTunnelStub<string>()
      const startTunnel: StartTunnel<string> = (config, setBindResult) =>
        config.localPort === 9000 ? Effect.fail('boom') : happy.startTunnel(config, setBindResult)
      await runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, localPort: 9000, requestedEnabled: true })
        await waitForState(store, (s) => s.error !== null)
        commitConfig(store, { localPort: 9001 })
        const state = await waitForState(store, (s) => s.currentEnabled)
        expect(state.error).toBeNull()
        expect(state.currentLocalPort).toBe(9001)
      }, startTunnel)
    })

    it('writes a post-bind failure to TunnelState.error and tears the tunnel down', async () => {
      const stub = makeStartTunnelStub<string>()
      await runDaemonTest(async ({ store }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.active.size).toBe(1)

        await Effect.runPromise(stub.failPostBind('relay-reset'))

        const state = await waitForState(store, (s) => s.error !== null)
        expect(state.error).toMatch(/relay-reset/)
        expect(state.currentEnabled).toBe(false)
        expect(state.currentSubdomain).toBeNull()
        expect(stub.active.size).toBe(0)
      }, stub.startTunnel)
    })
  })

  describe('properties', () => {
    const PROP_OPTS = { numRuns: 50 }

    const subdomainArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/)
    const portArb = fc.integer({ min: 1, max: 65_535 })

    it('always forwards the requested config into startTunnel', () =>
      fc.assert(
        fc.asyncProperty(subdomainArb, portArb, (subdomain, localPort) => {
          const stub = makeStartTunnelStub()
          return runDaemonTest(async ({ store }) => {
            commitConfig(store, {
              subdomain,
              rootDomain: 'loca.lt',
              localPort,
              requestedEnabled: true,
            })
            await waitForState(
              store,
              (s) =>
                s.currentEnabled &&
                s.currentSubdomain === subdomain &&
                s.currentLocalPort === localPort
            )
            expect(stub.calls).toEqual([{ subdomain, rootDomain: 'loca.lt', localPort }])
          }, stub.startTunnel)
        }),
        PROP_OPTS
      ))

    it('always settles on the most recent config after a sequence of reconfigurations', () =>
      fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.tuple(subdomainArb, portArb), {
            minLength: 1,
            maxLength: 3,
            selector: ([subdomain, port]): string => `${subdomain}|${String(port)}`,
          }),
          (reconfigurations) => {
            const stub = makeStartTunnelStub()
            return runDaemonTest(async ({ store }) => {
              for (let i = 0; i < reconfigurations.length; i++) {
                const [subdomain, localPort] = reconfigurations[i]
                commitConfig(store, {
                  subdomain,
                  rootDomain: 'loca.lt',
                  localPort,
                  requestedEnabled: true,
                })
                // oxlint-disable-next-line no-await-in-loop -- iteration must observe daemon settle before the next commit
                await stub.awaitCalls(i + 1)
              }
              const [lastSubdomain, lastPort] = reconfigurations[reconfigurations.length - 1]
              await waitForState(
                store,
                (s) =>
                  s.currentEnabled &&
                  s.currentSubdomain === lastSubdomain &&
                  s.currentLocalPort === lastPort
              )
              expect(stub.calls.length).toBe(reconfigurations.length)
            }, stub.startTunnel)
          }
        ),
        PROP_OPTS
      ))
  })
})
