/**
 * Tests for the apps-expo host handler record built by
 * {@link AppsBridgeExpo.makeHostHandlers}:
 *
 *  - **Type-only**: `makeHostHandlers` takes a resolved `TunnelStore`
 *    service + a host→web `reply` sender and returns the `Apps` host-side
 *    handler record (a pure `Effect<void>` per tag, no `TransportAdapter`
 *    requirement).
 *  - **Dispatch behavior**: `RequestTunnel` succeeds → `TunnelStarted`,
 *    fails (timeout, driven by `TestClock`) → `TunnelFailed`. Both replies
 *    ride the `reply` sender passed to `makeHostHandlers`; the test passes
 *    a capturing reply that records into `harness.sentMessages`.
 *
 * Sister file: `commit-and-await-tunnel.test.ts` covers the
 * `commitRequestedRunning` + `awaitTunnelOrigin` helpers these handlers
 * compose. Shared mocks + fake store live in
 * `__test-support__/host-receiver-test-mocks.ts`.
 */
import type { AppsBridge } from 'apps-core/bridge'
import { Duration, Effect, Fiber, TestClock, TestContext } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
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
import { type AppsHostSender } from './host-handlers.ts'
import { AppsBridgeExpo } from './index.ts'

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

// Capturing host→web reply — passed to `makeHostHandlers`; replies the
// handler dispatches land in `harness.sentMessages`.
const capturingReply: AppsHostSender = (message) =>
  Effect.sync(() => {
    harness.sentMessages.push(message)
  })

describe('AppsBridgeExpo.makeHostHandlers (type)', () => {
  it('takes a resolved TunnelStore service + reply sender and returns the Apps host handler record', () => {
    expectTypeOf(AppsBridgeExpo.makeHostHandlers).returns.toEqualTypeOf<
      MessageHandler.HandlersFor<AppsBridge['WebToHost']>
    >()
    expectTypeOf(AppsBridgeExpo.makeHostHandlers).parameter(0).toEqualTypeOf<TunnelStoreService>()
    expectTypeOf(AppsBridgeExpo.makeHostHandlers).parameter(1).toEqualTypeOf<AppsHostSender>()
  })
})

describe('AppsBridgeExpo.makeHostHandlers (RequestTunnel dispatch)', () => {
  it('Success → replies TunnelStarted carrying the composed origin (snapshot fast-path)', async () => {
    const store = makeFakeStore({
      initialState: {
        running: true,
        currentSubdomain: 'app-1',
        currentRootDomain: 'tun.example',
        currentLocalPort: 3000,
        error: null,
      },
    })
    const handlers = AppsBridgeExpo.makeHostHandlers(asTunnelStoreService(store), capturingReply)
    // The snapshot fast-path resolves synchronously with
    // `https://app-1.tun.example` → onSuccess dispatches TunnelStarted.
    await Effect.runPromise(handlers.RequestTunnel({ _tag: 'RequestTunnel' }))
    expect(harness.sentMessages).toEqual([
      { _tag: 'TunnelStarted', origin: 'https://app-1.tun.example' },
    ])
  })

  it('Failure → replies TunnelFailed carrying the prettied cause (timeout via TestClock)', async () => {
    // Empty state → the default 15s timeout fires → TunnelTimedOut →
    // matchCauseEffect's onFailure branch dispatches `TunnelFailed`. We
    // drive the timeout via `TestClock` so the test stays deterministic
    // and millisecond-fast.
    const store = makeFakeStore()
    const handlers = AppsBridgeExpo.makeHostHandlers(asTunnelStoreService(store), capturingReply)
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(handlers.RequestTunnel({ _tag: 'RequestTunnel' }))
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
