/**
 * Behavioral tests for {@link commitAndAwaitTunnel}. Sister file to
 * `host-receiver-layer.test.ts`, which covers the ReceiverLayer surface
 * that consumes this helper. Both files share the mock harness in
 * `__test-support__/host-receiver-test-mocks.ts`.
 */
import { fc, test as fcTest } from '@fast-check/jest'
import { Cause, Duration, Effect } from 'effect'

import {
  harness,
  makeFakeStore,
  mockBuildAppsCoreFactory,
  mockBuildSharedStructuresFactory,
  mockBuildTunnelCoreFactory,
  resetHarness,
  type FakeStore,
} from './__test-support__/host-receiver-test-mocks.ts'

// `jest.mock` calls are hoisted above imports — Jest's babel-plugin
// requires the factory to be an *inline* function (a bare imported
// identifier is rejected). Inside that inline arrow we can still call
// out to an imported builder because Jest's hoister allows references
// whose name starts with `mock`. See `host-receiver-test-mocks.ts` for
// the wiring details.
jest.mock('tunnel-core/livestore', () => mockBuildTunnelCoreFactory())
jest.mock('shared-structures-core/livestore', () => mockBuildSharedStructuresFactory())
jest.mock('apps-core/bridge', () => mockBuildAppsCoreFactory())

import type { Context } from 'effect'
import type { TunnelStore } from 'tunnel-core/livestore'
import { commitAndAwaitTunnel, TunnelTimedOut } from './commit-and-await-tunnel.ts'

/** Cast — production code only invokes the three methods we mock. */
const asTunnelStoreService = (store: FakeStore): Context.Tag.Service<typeof TunnelStore> =>
  // The livestore `Store` interface declares many fields the production
  // helper never touches; routing through `unknown` is the standard
  // test-only escape hatch for this kind of structural narrowing.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  store as unknown as Context.Tag.Service<typeof TunnelStore>

beforeEach(() => {
  resetHarness()
})

describe('commitAndAwaitTunnel', () => {
  describe('active === false short-circuit', () => {
    it('commits requestedRunning: false and returns null without touching subscribe/query', async () => {
      const store = makeFakeStore()
      const result = await Effect.runPromise(
        commitAndAwaitTunnel(asTunnelStoreService(store), false)
      )
      expect(result).toBeNull()
      const cfgFn = harness.tunnelConfigSet
      expect(cfgFn).toBeDefined()
      expect(cfgFn).toHaveBeenCalledTimes(1)
      expect(cfgFn).toHaveBeenCalledWith({ requestedRunning: false })
      expect(store.commit).toHaveBeenCalledTimes(1)
      // The commit payload is the event the (mocked) tunnelConfigSet
      // returned — assert provenance so future implementation drift
      // (e.g. switching to a different event) fails loudly here.
      expect(store.commit).toHaveBeenCalledWith({
        _tag: 'tunnelConfigSet',
        args: { requestedRunning: false },
      })
      expect(store.subscribe).not.toHaveBeenCalled()
      expect(store.query).not.toHaveBeenCalled()
    })
  })

  describe('active === true snapshot-first short-circuit', () => {
    fcTest.prop({
      subdomain: fc.stringMatching(/^[a-z0-9-]{1,32}$/),
      rootDomain: fc.stringMatching(/^[a-z0-9.-]{1,64}$/),
      localPort: fc.integer({ min: 1, max: 65_535 }),
    })(
      'resolves with `https://{sub}.{root}` when the snapshot already matches',
      async ({ subdomain, rootDomain, localPort }) => {
        const store = makeFakeStore({
          initialState: {
            running: true,
            currentSubdomain: subdomain,
            currentRootDomain: rootDomain,
            currentLocalPort: localPort,
            error: null,
          },
        })
        const result = await Effect.runPromise(
          commitAndAwaitTunnel(asTunnelStoreService(store), true)
        )
        expect(result).toBe(`https://${subdomain}.${rootDomain}`)
        expect(harness.tunnelConfigSet).toHaveBeenCalledWith({ requestedRunning: true })
        // The subscribe path is skipped when the snapshot already matches.
        expect(store.subscribe).not.toHaveBeenCalled()
        expect(store.query).toHaveBeenCalledTimes(1)
      }
    )

    fcTest.prop({
      running: fc.boolean(),
      currentSubdomain: fc.option(fc.stringMatching(/^[a-z0-9-]{1,32}$/), { nil: null }),
      currentRootDomain: fc.option(fc.stringMatching(/^[a-z0-9.-]{1,64}$/), { nil: null }),
    })(
      'does not short-circuit unless running AND both domain fields are non-null',
      async ({ running, currentSubdomain, currentRootDomain }) => {
        // For every non-matching snapshot, the subscribe path is taken
        // (not the immediate resolve). Short-circuit happens iff
        // `running && sub !== null && root !== null` — covered by the
        // previous property — so skip that case here.
        const matches = running && currentSubdomain !== null && currentRootDomain !== null
        if (matches) return
        const store = makeFakeStore({
          initialState: {
            running,
            currentSubdomain,
            currentRootDomain,
            currentLocalPort: null,
            error: null,
          },
        })
        const fiber = Effect.runFork(
          commitAndAwaitTunnel(asTunnelStoreService(store), true, Duration.millis(20))
        )
        // Yield enough microtasks for `Effect.async` to install the
        // subscriber. Two ticks is enough for the current Effect
        // runtime — bump if a runtime upgrade trips this.
        await Promise.resolve()
        await Promise.resolve()
        expect(store.subscribe).toHaveBeenCalledTimes(1)
        // Clean up — wait for the timeout so jest doesn't complain
        // about a leaked fiber.
        await Effect.runPromise(fiber.await)
      }
    )
  })

  describe('active === true subscribe-then-resolve', () => {
    it('resolves once a matching state is pushed via the live subscriber', async () => {
      const store = makeFakeStore({
        initialState: {
          running: false,
          currentSubdomain: 'sub',
          currentRootDomain: 'root.example',
          currentLocalPort: 3000,
          error: null,
        },
      })
      const fiber = Effect.runFork(
        commitAndAwaitTunnel(asTunnelStoreService(store), true, Duration.millis(50))
      )
      await Promise.resolve()
      await Promise.resolve()
      expect(store.subscribe).toHaveBeenCalledTimes(1)
      // Push a matching state — the subscriber should resolve.
      store.pushState({
        running: true,
        currentSubdomain: 'sub',
        currentRootDomain: 'root.example',
        currentLocalPort: 3000,
        error: null,
      })
      const exit = await Effect.runPromise(fiber.await)
      if (exit._tag !== 'Success') throw new Error(`expected Success, got ${exit._tag}`)
      expect(exit.value).toBe('https://sub.root.example')
      // The helper unsubscribes after resolving so we don't leak
      // subscriber slots.
      expect(store.unsubscribeCalls()).toBe(1)
    })

    it('ignores intermediate non-matching pushes and resolves on the first matching one', async () => {
      const store = makeFakeStore({
        initialState: {
          running: true,
          currentSubdomain: null,
          currentRootDomain: 'root.example',
          currentLocalPort: 3000,
          error: null,
        },
      })
      const fiber = Effect.runFork(
        commitAndAwaitTunnel(asTunnelStoreService(store), true, Duration.millis(50))
      )
      await Promise.resolve()
      await Promise.resolve()
      // Push partial (still missing rootDomain after another change) — must not resolve.
      store.pushState({
        running: true,
        currentSubdomain: 'sub',
        currentRootDomain: null,
        currentLocalPort: 3000,
        error: null,
      })
      // running=false — also must not resolve.
      store.pushState({
        running: false,
        currentSubdomain: 'sub',
        currentRootDomain: 'root.example',
        currentLocalPort: 3000,
        error: null,
      })
      // Push fully-populated state — resolves now.
      store.pushState({
        running: true,
        currentSubdomain: 'sub',
        currentRootDomain: 'root.example',
        currentLocalPort: 3000,
        error: null,
      })
      const exit = await Effect.runPromise(fiber.await)
      if (exit._tag !== 'Success') throw new Error(`expected Success, got ${exit._tag}`)
      expect(exit.value).toBe('https://sub.root.example')
    })
  })

  describe('active === true timeout', () => {
    fcTest.prop({
      timeoutMs: fc.integer({ min: 1, max: 50 }),
    })(
      'fails with TunnelTimedOut carrying the configured timeoutMs and unsubscribes',
      async ({ timeoutMs }) => {
        const store = makeFakeStore()
        const exit = await Effect.runPromise(
          Effect.exit(
            commitAndAwaitTunnel(asTunnelStoreService(store), true, Duration.millis(timeoutMs))
          )
        )
        if (exit._tag !== 'Failure') throw new Error(`expected Failure, got ${exit._tag}`)
        const failure = Cause.failureOption(exit.cause)
        if (failure._tag !== 'Some') throw new Error('expected failureOption Some')
        const err = failure.value
        if (!(err instanceof TunnelTimedOut)) throw new Error('expected TunnelTimedOut')
        expect(err.timeoutMs).toBe(timeoutMs)
        // The `Effect.async` finalizer fires when timeoutFail
        // interrupts the underlying fiber → unsubscribe is invoked.
        expect(store.unsubscribeCalls()).toBe(1)
      }
    )
  })
})
