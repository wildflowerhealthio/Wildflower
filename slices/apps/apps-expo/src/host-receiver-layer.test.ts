/**
 * Tests for the apps-expo host handler record built by
 * {@link AppsBridgeExpo.makeHostHandlers}:
 *
 *  - **Type-only**: `makeHostHandlers` takes a resolved `TunnelStore`
 *    service and returns the `Apps` host-side handler record. Replies
 *    route through `AppsBridge.Host.send(...)` which the bridge transport
 *    discharges via its own `TransportAdapter` per invocation — at test
 *    time we discharge with `TestPlatformAdapterLayer.make()`.
 *  - **Dispatch behavior**: `RequestTunnel` succeeds → `TunnelStarted`,
 *    fails (timeout, driven by `TestClock`) → `TunnelFailed`, both
 *    dispatched via the mocked `AppsBridge.Host.send`.
 *
 * Sister file: `commit-and-await-tunnel.test.ts` covers the
 * `commitRequestedRunning` + `awaitTunnelOrigin` helpers these handlers
 * compose. Shared mocks + fake store live in
 * `__test-support__/host-receiver-test-mocks.ts`.
 */
import type { AppsBridge } from 'apps-core/bridge'
import { Duration, Effect, Fiber, TestClock, TestContext } from 'effect'
import { type Bridge, TestPlatformAdapterLayer } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'

import {
  harness,
  makeFakeStore,
  mockBuildAppsCoreFactory,
  mockBuildLivestoreBaseFactory,
  mockBuildTunnelCoreFactory,
  resetHarness,
  type FakeStore,
} from './__test-support__/host-receiver-test-mocks.ts'

jest.mock('@livestore/livestore', () => mockBuildLivestoreBaseFactory())
jest.mock('tunnel-core/livestore', () => mockBuildTunnelCoreFactory())
jest.mock('apps-core/bridge', () => mockBuildAppsCoreFactory())

import type { TunnelStoreService } from './commit-and-await-tunnel.ts'
import { AppsBridgeExpo } from './index.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

/**
 * The fake livestore only implements the three methods the production
 * helpers touch (`commit` / `query` / `subscribe`); route it through
 * `unknown` to the full `TunnelStore` service the handler factory expects.
 */
const asTunnelStoreService = (store: FakeStore): TunnelStoreService =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  store as unknown as TunnelStoreService

beforeEach(() => {
  resetHarness()
})

describe('AppsBridgeExpo.makeHostHandlers (type)', () => {
  it('takes a resolved TunnelStore service and returns the Apps host handler record', () => {
    expectTypeOf(AppsBridgeExpo.makeHostHandlers).returns.toEqualTypeOf<
      Bridge.HalfHandlers<AppsBridge['Host']>
    >()
    expectTypeOf(AppsBridgeExpo.makeHostHandlers).parameter(0).toEqualTypeOf<TunnelStoreService>()
  })
})

describe('AppsBridgeExpo.makeHostHandlers (RequestTunnel dispatch)', () => {
  it('Success → AppsBridge.Host.send called with TunnelStarted carrying the composed origin (snapshot fast-path)', async () => {
    const store = makeFakeStore({
      initialState: {
        running: true,
        currentSubdomain: 'app-1',
        currentRootDomain: 'tun.example',
        currentLocalPort: 3000,
        error: null,
      },
    })
    const handlers = AppsBridgeExpo.makeHostHandlers(asTunnelStoreService(store))
    // The snapshot fast-path resolves synchronously with
    // `https://app-1.tun.example` → onSuccess dispatches TunnelStarted.
    await Effect.runPromise(
      handlers.RequestTunnel({ _tag: 'RequestTunnel' }).pipe(Effect.provide(adapterLayer))
    )
    expect(harness.sentMessages).toEqual([
      { _tag: 'TunnelStarted', origin: 'https://app-1.tun.example' },
    ])
  })

  it('Failure → AppsBridge.Host.send called with TunnelFailed carrying the prettied cause (timeout via TestClock)', async () => {
    // Empty state → the default 15s timeout fires → TunnelTimedOut →
    // matchCauseEffect's onFailure branch dispatches `TunnelFailed`. We
    // drive the timeout via `TestClock` so the test stays deterministic
    // and millisecond-fast.
    const store = makeFakeStore()
    const handlers = AppsBridgeExpo.makeHostHandlers(asTunnelStoreService(store))
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          handlers.RequestTunnel({ _tag: 'RequestTunnel' }).pipe(Effect.provide(adapterLayer))
        )
        // Let the dispatch install its subscriber on the live store
        // before the clock jumps.
        yield* Effect.yieldNow()
        yield* Effect.yieldNow()
        yield* TestClock.adjust(Duration.seconds(20))
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext))
    )
    expect(harness.sentMessages).toHaveLength(1)
    const [msg] = harness.sentMessages
    expect(msg?._tag).toBe('TunnelFailed')
    // Reason is `Cause.pretty(cause)` — assert it mentions the tag
    // rather than pinning the full string (which depends on Effect's
    // pretty-print formatting).
    if (msg?._tag !== 'TunnelFailed') throw new Error('expected TunnelFailed')
    expect(msg.reason).toMatch(/TunnelTimedOut/)
  })
})
