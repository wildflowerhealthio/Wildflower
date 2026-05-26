/**
 * Tests for the {@link AppsBridgeExpo.ReceiverLayer} surface:
 *
 *  - **Type-only**: the Layer's `R` requires only `TunnelStore` (the
 *    `senderRef` parameter is React state captured by the hook, not a
 *    layer requirement).
 *  - **Dispatch behavior**: `RequestTunnel` succeeds → `TunnelStarted`,
 *    fails (timeout, driven by `TestClock`) → `TunnelFailed`, dispatched
 *    via the supplied `senderRef`.
 *
 * Sister file: `commit-and-await-tunnel.test.ts` covers the
 * `commitAndAwaitTunnel` helper this layer dispatches into. Shared
 * mocks + fake store live in `__test-support__/host-receiver-test-mocks.ts`.
 */
import { Duration, Effect, Fiber, Layer, TestClock, TestContext } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import type { RefObject } from 'react'

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
import type { AppsHostMessageSender, AppsHostToWebMessage } from './host-receiver-layer.ts'
import { AppsBridgeExpo } from './index.ts'

beforeEach(() => {
  resetHarness()
})

/**
 * Sender ref whose `.current` records every sent message into
 * `harness.sentMessages`. Returned Effect resolves immediately —
 * mirroring the real transport's post-`__Ready` behaviour for this
 * test's purposes.
 */
const makeRecordingSenderRef = (): RefObject<AppsHostMessageSender | null> => ({
  current: (message: AppsHostToWebMessage): Effect.Effect<void> =>
    Effect.sync(() => {
      ;(harness.sentMessages ??= []).push(message)
    }),
})

describe('AppsBridgeExpo.ReceiverLayer (type)', () => {
  it('returns a Layer providing the Apps host handler tag and requiring only TunnelStore', () => {
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>, never, TunnelStore>
    >()
  })

  it('takes one argument: the host→web sender ref', () => {
    expectTypeOf(AppsBridgeExpo.ReceiverLayer).parameters.toEqualTypeOf<
      [RefObject<AppsHostMessageSender | null>]
    >()
  })
})

/**
 * Build the receiver layer against `store` + `senderRef`, capture its
 * handlers via the `apps-core/bridge` mock, and return them.
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
  store: FakeStore,
  senderRef: RefObject<AppsHostMessageSender | null>
): Promise<NonNullable<typeof harness.lastHandlers>> => {
  const tunnelStoreLayer = Layer.succeed(requireTunnelStoreTag(), store)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const layer = AppsBridgeExpo.ReceiverLayer(senderRef).pipe(
    Layer.provide(tunnelStoreLayer)
  ) as Layer.Layer<MessageHandler.TagId<'Apps', 'Host'>>
  await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped))
  const handlers = harness.lastHandlers
  if (handlers === undefined || handlers === null) {
    throw new Error('receiver-layer mock failed to capture handlers')
  }
  return handlers
}

describe('AppsBridgeExpo.ReceiverLayer (RequestTunnel dispatch)', () => {
  it('Success → senderRef called with TunnelStarted carrying the composed origin (snapshot fast-path)', async () => {
    const store = makeFakeStore({
      initialState: {
        running: true,
        currentSubdomain: 'app-1',
        currentRootDomain: 'tun.example',
        currentLocalPort: 3000,
        error: null,
      },
    })
    const senderRef = makeRecordingSenderRef()
    const handlers = await buildHandlersWithStore(store, senderRef)
    // The snapshot fast-path resolves synchronously with
    // `https://app-1.tun.example` → onSuccess routes through the
    // senderRef as TunnelStarted.
    await Effect.runPromise(handlers.RequestTunnel())
    expect(harness.sentMessages).toEqual([
      { _tag: 'TunnelStarted', origin: 'https://app-1.tun.example' },
    ])
  })

  it('Failure → senderRef called with TunnelFailed carrying the stringified cause (timeout via TestClock)', async () => {
    // Empty state → the default 15s timeout fires → TunnelTimedOut →
    // matchEffect's onFailure branch routes through the senderRef as
    // `TunnelFailed { reason }`. We drive the timeout via `TestClock`
    // so the test stays deterministic and millisecond-fast.
    const store = makeFakeStore()
    const senderRef = makeRecordingSenderRef()
    const handlers = await buildHandlersWithStore(store, senderRef)
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(handlers.RequestTunnel())
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

  it('senderRef.current === null → success path drops loud (Effect.logError) and records no message', async () => {
    const store = makeFakeStore({
      initialState: {
        running: true,
        currentSubdomain: 'app-2',
        currentRootDomain: 'tun.example',
        currentLocalPort: 3000,
        error: null,
      },
    })
    const senderRef: RefObject<AppsHostMessageSender | null> = { current: null }
    const handlers = await buildHandlersWithStore(store, senderRef)
    await Effect.runPromise(handlers.RequestTunnel())
    expect(harness.sentMessages).toEqual([])
  })
})
