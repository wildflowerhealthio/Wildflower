/**
 * Tests for the {@link AppsBridgeExpo.ReceiverLayer} surface:
 *
 *  - **Type-only**: the Layer's `R` requires only `TunnelStore`.
 *  - **Dispatch behavior**: `RequestTunnel` succeeds → `TunnelStarted`,
 *    fails (timeout, driven by `TestClock`) → `TunnelFailed`.
 *
 * Sister file: `commit-and-await-tunnel.test.ts` covers the
 * `commitAndAwaitTunnel` helper this layer dispatches into. Shared
 * mocks + fake store live in `__test-support__/host-receiver-test-mocks.ts`.
 */
import { Duration, Effect, Fiber, Layer, TestClock, TestContext } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'

import {
  harness,
  makeFakeStore,
  mockBuildAppsCoreFactory,
  mockBuildSharedStructuresFactory,
  mockBuildTunnelCoreFactory,
  requireTunnelStoreTag,
  resetHarness,
  type FakeStore,
} from './__test-support__/host-receiver-test-mocks.ts'

// `jest.mock` calls are hoisted above imports — Jest's babel-plugin
// requires the factory to be an *inline* function (a bare imported
// identifier is rejected). Inside that inline arrow we can still call
// out to an imported builder because Jest's hoister allows references
// whose name starts with `mock`. The harness factories follow that
// convention.
jest.mock('tunnel-core/livestore', () => mockBuildTunnelCoreFactory())
jest.mock('shared-structures-core/livestore', () => mockBuildSharedStructuresFactory())
jest.mock('apps-core/bridge', () => mockBuildAppsCoreFactory())

import type { TunnelStore } from 'tunnel-core/livestore'
import { AppsBridgeExpo } from './index.ts'

beforeEach(() => {
  resetHarness()
})

describe('AppsBridgeExpo.ReceiverLayer (type)', () => {
  it('returns a Layer providing the Apps host handler tag and requiring only TunnelStore', () => {
    // `BareSender` is no longer a layer-build requirement — the bridge
    // transport's dispatch fiber provides it per-handler-invocation.
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>, never, TunnelStore>
    >()
  })

  it('takes no arguments', () => {
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).parameters.toEqualTypeOf<[]>()
  })
})

/**
 * Build the receiver layer against `store`, capture its handlers via
 * the `apps-core/bridge` mock, and return the captured handlers record.
 *
 * Type note: the runtime `TunnelStore` value is the mocked tag the
 * `tunnel-core/livestore` factory installs (see `harness.tunnelStoreTag`),
 * so `Layer.provide(tunnelStoreLayer)` discharges it correctly. The
 * compiler can't see that — the real `TunnelStore` import is a class
 * with a richer service shape — so the resulting layer is cast through
 * the `MessageHandler.TagId<'Apps', 'Host'>` shape with no other
 * requirements before `Layer.build`.
 */
const buildHandlersWithStore = async (
  store: FakeStore
): Promise<NonNullable<typeof harness.lastHandlers>> => {
  const tunnelStoreLayer = Layer.succeed(requireTunnelStoreTag(), store)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const layer = AppsBridgeExpo.ReceiverLayer().pipe(Layer.provide(tunnelStoreLayer)) as Layer.Layer<
    MessageHandler.TagId<'Apps', 'Host'>
  >
  await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))
  const handlers = harness.lastHandlers
  if (handlers === undefined || handlers === null) {
    throw new Error('receiver-layer mock failed to capture handlers')
  }
  return handlers
}

describe('AppsBridgeExpo.ReceiverLayer (RequestTunnel dispatch)', () => {
  it('Success → AppsBridge.Host.send TunnelStarted with the composed origin (snapshot fast-path)', async () => {
    const store = makeFakeStore({
      initialState: {
        running: true,
        currentSubdomain: 'app-1',
        currentRootDomain: 'tun.example',
        currentLocalPort: 3000,
        error: null,
      },
    })
    const handlers = await buildHandlersWithStore(store)
    // The handler body is `Effect.Effect<void, never, never>`
    // post-`matchEffect`. The snapshot fast-path resolves synchronously
    // with `https://app-1.tun.example` → onSuccess sends TunnelStarted.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    await Effect.runPromise(handlers.RequestTunnel() as Effect.Effect<void>)
    expect(harness.sentMessages).toEqual([
      { _tag: 'TunnelStarted', origin: 'https://app-1.tun.example' },
    ])
  })

  it('Failure → AppsBridge.Host.send TunnelFailed with the stringified cause (timeout via TestClock)', async () => {
    // Empty state → the default 15s timeout fires → TunnelTimedOut →
    // matchEffect's onFailure branch sends `TunnelFailed { reason }`.
    // We drive the timeout via `TestClock` so the test stays
    // deterministic and millisecond-fast.
    const store = makeFakeStore()
    const handlers = await buildHandlersWithStore(store)
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          handlers.RequestTunnel() as Effect.Effect<void>
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
    const [msg] = harness.sentMessages ?? []
    expect(msg?._tag).toBe('TunnelFailed')
    // Reason is `String(cause)` for the `TunnelTimedOut` cause —
    // assert it mentions the tag rather than pinning the full string
    // (which depends on Effect's Cause.pretty formatting).
    if (msg?._tag !== 'TunnelFailed') throw new Error('expected TunnelFailed')
    expect(msg.reason).toMatch(/TunnelTimedOut/)
  })
})
