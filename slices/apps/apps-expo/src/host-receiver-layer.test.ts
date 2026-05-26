/**
 * Tests for the {@link AppsBridgeExpo.ReceiverLayer} surface:
 *
 *  - **Type-only**: the Layer's `R` requires only `TunnelStore`. Replies
 *    route through `AppsBridge.Host.send(...)` which the bridge transport
 *    discharges via its own `TransportAdapter` per invocation — at test
 *    time we discharge with `TestPlatformAdapterLayer.make()`.
 *  - **Dispatch behavior**: `RequestTunnel` succeeds → `TunnelStarted`,
 *    fails (timeout, driven by `TestClock`) → `TunnelFailed`, both
 *    dispatched via the mocked `AppsBridge.Host.send`.
 *
 * Sister file: `commit-and-await-tunnel.test.ts` covers the
 * `commitRequestedRunning` + `awaitTunnelOrigin` helpers this layer
 * composes. Shared mocks + fake store live in
 * `__test-support__/host-receiver-test-mocks.ts`.
 */
import { Duration, Effect, Fiber, Layer, TestClock, TestContext } from 'effect'
import { TestPlatformAdapterLayer, type MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'

import {
  harness,
  makeFakeStore,
  mockBuildAppsCoreFactory,
  mockBuildLivestoreBaseFactory,
  mockBuildTunnelCoreFactory,
  requireTunnelStoreTag,
  resetHarness,
  type FakeStore,
} from './__test-support__/host-receiver-test-mocks.ts'

jest.mock('@livestore/livestore', () => mockBuildLivestoreBaseFactory())
jest.mock('tunnel-core/livestore', () => mockBuildTunnelCoreFactory())
jest.mock('apps-core/bridge', () => mockBuildAppsCoreFactory())

import type { TunnelStore } from 'tunnel-core/livestore'
import { AppsBridgeExpo } from './index.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

beforeEach(() => {
  resetHarness()
})

describe('AppsBridgeExpo.ReceiverLayer (type)', () => {
  it('is a Layer providing the Apps host handler tag and requiring only TunnelStore', () => {
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>, never, TunnelStore>
    >()
  })
})

/**
 * Build the receiver layer against `store`, capture its handlers via the
 * `apps-core/bridge` mock, and return them.
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
  const layer = AppsBridgeExpo.ReceiverLayer.pipe(Layer.provide(tunnelStoreLayer)) as Layer.Layer<
    MessageHandler.TagId<'Apps', 'Host'>
  >
  await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))
  const handlers = harness.lastHandlers
  if (handlers === null) {
    throw new Error('receiver-layer mock failed to capture handlers')
  }
  return handlers
}

describe('AppsBridgeExpo.ReceiverLayer (RequestTunnel dispatch)', () => {
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
    const handlers = await buildHandlersWithStore(store)
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
    const handlers = await buildHandlersWithStore(store)
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
