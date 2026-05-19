/**
 * Tests for `runTunnelDaemon` — verifies the daemon's reaction to
 * `TunnelConfig` transitions against an in-memory livestore plus a stubbed
 * `startTunnel`. The stub succeeds with `void` to signal "tunnel up" (the
 * same signal the daemon's `Effect.tap` watches for) and is forked by the
 * daemon into a sub-scope per tunnel.
 */
import { makeAdapter } from '@livestore/adapter-node'
import type { Store } from '@livestore/livestore'
import { createStorePromise } from '@livestore/livestore'
import { Effect, type Scope } from 'effect'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { schema, TunnelConfig, TunnelState, TunnelStore } from '../livestore/index.ts'
import { type ResolvedConfig, runTunnelDaemon } from './index.ts'

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

interface StartTunnelStub {
  readonly startTunnel: (config: ResolvedConfig) => Effect.Effect<void, never, Scope.Scope>
  readonly calls: ReadonlyArray<ResolvedConfig>
  readonly awaitCalls: (n: number) => Promise<ReadonlyArray<ResolvedConfig>>
}

const WAIT_TIMEOUT_MS = 2_000

const makeFreshStore = (): Promise<Store<typeof schema, object>> =>
  createStorePromise({
    adapter: makeAdapter({ storage: { type: 'in-memory' } }),
    schema,
    storeId: `tunnel-daemon-it-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  })

const makeStartTunnelStub = (): StartTunnelStub => {
  const calls: ResolvedConfig[] = []
  const subscribers: (() => void)[] = []
  const startTunnel = (config: ResolvedConfig): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      calls.push(config)
      for (const fire of subscribers.splice(0, subscribers.length)) fire()
    })
  const awaitCalls = (n: number): Promise<ReadonlyArray<ResolvedConfig>> =>
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
  return { startTunnel, calls, awaitCalls }
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

const configId = (c: ResolvedConfig): string =>
  `${c.subdomain}|${c.rootDomain}|${String(c.localPort)}`

interface DaemonTestCtx {
  readonly store: Store<typeof schema, object>
  readonly calls: ReadonlyArray<ResolvedConfig>
  readonly awaitCalls: (n: number) => Promise<ReadonlyArray<ResolvedConfig>>
}

const runDaemonTest = async (
  body: (ctx: DaemonTestCtx) => Promise<void>,
  stub: StartTunnelStub = makeStartTunnelStub()
): Promise<void> => {
  const store = await makeFreshStore()
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.forkScoped(runTunnelDaemon(stub.startTunnel))
        yield* Effect.promise(() => body({ store, calls: stub.calls, awaitCalls: stub.awaitCalls }))
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
    it('calls startTunnel with the requested config when requestedEnabled flips to true', () =>
      runDaemonTest(async ({ store, calls }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await waitForState(store, (s) => s.currentEnabled)
        expect(calls).toEqual([FULL_CONFIG])
      }))

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

    it('produces exactly one start call across an off→on→off cycle', () =>
      runDaemonTest(async ({ store, calls }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await waitForState(store, (s) => s.currentEnabled)
        commitConfig(store, { requestedEnabled: false })
        await waitForState(store, (s) => !s.currentEnabled)
        expect(calls).toEqual([FULL_CONFIG])
      }))
  })

  describe('partial config', () => {
    it('stays parked when requestedEnabled is true but subdomain is null', () =>
      runDaemonTest(async ({ store, calls }) => {
        // Set requestedEnabled before seeding subdomain/rootDomain. The
        // daemon should NoOp until the config is complete.
        commitConfig(store, { localPort: 8080, requestedEnabled: true })
        // Wait long enough for any spurious tick to have fired.
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(calls).toEqual([])
        const state = store.query(TunnelState.queries.current$)
        expect(state.currentEnabled).toBe(false)
      }))

    it('starts once the missing fields are filled in', () =>
      runDaemonTest(async ({ store, calls }) => {
        commitConfig(store, { localPort: 8080, requestedEnabled: true })
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(calls).toEqual([])
        commitConfig(store, { subdomain: 'wildflower-expo-dev', rootDomain: 'loca.lt' })
        await waitForState(store, (s) => s.currentEnabled)
        expect(calls).toEqual([FULL_CONFIG])
      }))
  })

  describe('reconfiguration mid-run', () => {
    it('re-invokes startTunnel with the new subdomain', () =>
      runDaemonTest(async ({ store, calls, awaitCalls }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await awaitCalls(1)
        commitConfig(store, { subdomain: 'wildflower-expo-prod' })
        await awaitCalls(2)
        expect(calls.map((c) => c.subdomain)).toEqual([
          'wildflower-expo-dev',
          'wildflower-expo-prod',
        ])
      }))

    it('re-invokes startTunnel with the new local port', () =>
      runDaemonTest(async ({ store, calls, awaitCalls }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await awaitCalls(1)
        commitConfig(store, { localPort: 9090 })
        await awaitCalls(2)
        expect(calls.map((c) => c.localPort)).toEqual([8080, 9090])
      }))
  })

  describe('reconfiguration scope teardown', () => {
    /**
     * Real-world `startTunnel` implementations bind their connection
     * inside an `Effect.acquireRelease` block and then sit on
     * `Effect.never` until the sub-scope closes. This stub mirrors that
     * shape so the "close the previous sub-scope on reconfiguration"
     * invariant is actually exercised.
     */
    const makeLongRunningStub = (): StartTunnelStub & {
      readonly active: Set<string>
    } => {
      const calls: ResolvedConfig[] = []
      const active = new Set<string>()
      const subscribers: (() => void)[] = []
      const startTunnel = (config: ResolvedConfig): Effect.Effect<void, never, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.sync(() => {
            calls.push(config)
            active.add(configId(config))
            for (const fire of subscribers.splice(0, subscribers.length)) fire()
          }),
          () =>
            Effect.sync(() => {
              active.delete(configId(config))
            })
        )
      const awaitCalls = (n: number): Promise<ReadonlyArray<ResolvedConfig>> =>
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
      return { startTunnel, calls, awaitCalls, active }
    }

    it('releases the previous sub-scope on reconfigure (exactly one active tunnel)', async () => {
      const stub = makeLongRunningStub()
      await runDaemonTest(async ({ store, awaitCalls }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await awaitCalls(1)
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.active.size).toBe(1)

        commitConfig(store, { localPort: 9090 })
        await awaitCalls(2)
        await waitForState(store, (s) => s.currentLocalPort === 9090)
        expect(stub.active.size).toBe(1)
      }, stub)
    })

    it('releases the active sub-scope when requestedEnabled flips back to false', async () => {
      const stub = makeLongRunningStub()
      await runDaemonTest(async ({ store, awaitCalls }) => {
        commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
        await awaitCalls(1)
        await waitForState(store, (s) => s.currentEnabled)
        expect(stub.active.size).toBe(1)

        commitConfig(store, { requestedEnabled: false })
        await waitForState(store, (s) => !s.currentEnabled)
        expect(stub.active.size).toBe(0)
      }, stub)
    })
  })

  describe('error path', () => {
    let store: Store<typeof schema, object>

    beforeEach(async () => {
      store = await makeFreshStore()
    })

    afterEach(async () => {
      await store.shutdownPromise().catch(() => undefined)
    })

    it('writes the failure to TunnelState.error and leaves requestedEnabled intact', async () => {
      const failingStartTunnel = (
        _config: ResolvedConfig
      ): Effect.Effect<void, string, Scope.Scope> => Effect.fail('boom')

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(runTunnelDaemon(failingStartTunnel))
            yield* Effect.promise(async () => {
              commitConfig(store, { ...FULL_CONFIG, requestedEnabled: true })
              const state = await waitForState(store, (s) => s.error !== null)
              expect(state.error).toMatch(/boom/)
              expect(state.currentEnabled).toBe(false)
              const config = store.query(TunnelConfig.queries.current$)
              expect(config?.requestedEnabled).toBe(true)
            })
          }).pipe(Effect.provide(TunnelStore.layerFrom(store)))
        )
      )
    })

    it('recovers on a reconfigure with a healthy startTunnel', async () => {
      const stub = makeStartTunnelStub()
      const startTunnel = (config: ResolvedConfig): Effect.Effect<void, string, Scope.Scope> =>
        Effect.gen(function* () {
          if (config.localPort === 9000) return yield* Effect.fail('boom')
          return yield* stub.startTunnel(config)
        })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(runTunnelDaemon(startTunnel))
            yield* Effect.promise(async () => {
              commitConfig(store, { ...FULL_CONFIG, localPort: 9000, requestedEnabled: true })
              await waitForState(store, (s) => s.error !== null)
              commitConfig(store, { localPort: 9001 })
              const state = await waitForState(store, (s) => s.currentEnabled)
              expect(state.error).toBeNull()
              expect(state.currentLocalPort).toBe(9001)
            })
          }).pipe(Effect.provide(TunnelStore.layerFrom(store)))
        )
      )
    })
  })

  describe('properties', () => {
    const PROP_OPTS = { numRuns: 3 }

    const subdomainArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/)
    const portArb = fc.integer({ min: 1, max: 65_535 })

    it('always forwards the requested config into startTunnel', () =>
      fc.assert(
        fc.asyncProperty(subdomainArb, portArb, (subdomain, localPort) =>
          runDaemonTest(async ({ store, calls }) => {
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
            expect(calls).toEqual([{ subdomain, rootDomain: 'loca.lt', localPort }])
          })
        ),
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
          (reconfigurations) =>
            runDaemonTest(async ({ store, calls, awaitCalls }) => {
              for (let i = 0; i < reconfigurations.length; i++) {
                const [subdomain, localPort] = reconfigurations[i]
                commitConfig(store, {
                  subdomain,
                  rootDomain: 'loca.lt',
                  localPort,
                  requestedEnabled: true,
                })
                // oxlint-disable-next-line no-await-in-loop -- iteration must observe daemon settle before the next commit
                await awaitCalls(i + 1)
              }
              const [lastSubdomain, lastPort] = reconfigurations[reconfigurations.length - 1]
              await waitForState(
                store,
                (s) =>
                  s.currentEnabled &&
                  s.currentSubdomain === lastSubdomain &&
                  s.currentLocalPort === lastPort
              )
              expect(calls.length).toBe(reconfigurations.length)
            })
        ),
        PROP_OPTS
      ))
  })
})
