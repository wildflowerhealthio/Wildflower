import { fc, test as fcTest } from '@fast-check/jest'
import { Effect, Schema } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import { BridgeTransport, TestPlatformAdapterLayer } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import { NavigationBridge } from 'navigation-core'
import { NavigationBridgeExpo } from './index.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

// Type-only assertions on `makeHostHandlers`'s signature. Hoisted to module
// scope so the type check fires at file load — `expect-type` is purely
// compile-time, so wrapping these in `it(...)` would have Jest report them
// as passing whether or not the type-level invariant holds.
expectTypeOf(NavigationBridgeExpo.makeHostHandlers).returns.toEqualTypeOf<
  Bridge.HalfHandlers<(typeof NavigationBridge)['Host']>
>()
expectTypeOf(NavigationBridgeExpo.makeHostHandlers)
  .parameter(0)
  .toEqualTypeOf<((route: { pathname: string; canGoBack: boolean }) => void) | undefined>()
expectTypeOf(NavigationBridgeExpo.makeHostHandlers)
  .parameter(1)
  .toEqualTypeOf<(() => void) | undefined>()

describe('NavigationBridgeExpo.makeHostHandlers (RouteChanged handler)', () => {
  fcTest.prop({
    pathname: fc.webPath(),
    canGoBack: fc.boolean(),
  })(
    'forwards the decoded {pathname, canGoBack} payload to onRouteChanged',
    async ({ pathname, canGoBack }) => {
      const onRouteChanged = jest.fn()
      const handlers = NavigationBridgeExpo.makeHostHandlers(onRouteChanged)
      await Effect.runPromise(
        handlers
          .RouteChanged({ _tag: 'RouteChanged', pathname, canGoBack })
          .pipe(Effect.provide(adapterLayer))
      )
      expect(onRouteChanged).toHaveBeenCalledTimes(1)
      expect(onRouteChanged).toHaveBeenCalledWith({ pathname, canGoBack })
    }
  )

  it('does not crash when onRouteChanged is omitted (dispatch fiber must keep draining)', async () => {
    const handlers = NavigationBridgeExpo.makeHostHandlers()
    await expect(
      Effect.runPromise(
        handlers
          .RouteChanged({ _tag: 'RouteChanged', pathname: '/foo', canGoBack: true })
          .pipe(Effect.provide(adapterLayer))
      )
    ).resolves.toBeUndefined()
  })

  it('invokes onUiReady when the SPA posts UIReady (host reveals the WebView)', async () => {
    const onUiReady = jest.fn()
    const handlers = NavigationBridgeExpo.makeHostHandlers(undefined, onUiReady)
    await Effect.runPromise(
      handlers.UIReady({ _tag: 'UIReady' }).pipe(Effect.provide(adapterLayer))
    )
    expect(onUiReady).toHaveBeenCalledTimes(1)
  })

  it('does not crash when onUiReady is omitted', async () => {
    const handlers = NavigationBridgeExpo.makeHostHandlers()
    await expect(
      Effect.runPromise(handlers.UIReady({ _tag: 'UIReady' }).pipe(Effect.provide(adapterLayer)))
    ).resolves.toBeUndefined()
  })

  it('keeps the BridgeTransport dispatch fiber draining after no-op handlers run', async () => {
    // Real `BridgeTransport.make` on the Host side with no-op handlers —
    // `onRouteChanged` omitted, so `RouteChanged` short-circuits. We enqueue
    // multiple RouteChanged messages via the live bareSender (the actual
    // dispatch path the WebView's `onMessage` exercises in prod), then issue
    // a `registerHandlers` call: it rides the same FIFO inbox, so its
    // resolution only happens once every message ahead of it has been
    // processed. A fiber crash during dispatch would surface here as a
    // rejected promise.
    const { layer: capturingAdapterLayer, liveBareSenderRef } = TestPlatformAdapterLayer.make({
      captureBareSenderLive: true,
    })
    const routeChangedEncoded = Schema.encodeSync(NavigationBridge.MessageSchemas.RouteChanged)({
      _tag: 'RouteChanged',
      pathname: '/a',
      canGoBack: false,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationBridge] as const,
          handlers: [NavigationBridgeExpo.makeHostHandlers()],
          side: 'Host',
        }).pipe(Effect.provide(capturingAdapterLayer))
        if (liveBareSenderRef.current === null) {
          throw new Error('liveBareSenderRef not captured')
        }
        yield* liveBareSenderRef.current(routeChangedEncoded)
        yield* liveBareSenderRef.current(routeChangedEncoded)
        yield* liveBareSenderRef.current(routeChangedEncoded)
        // Barrier: the register item sits behind the three messages in FIFO
        // order, so when it resolves they have all been dispatched.
        yield* transport.registerHandlers([NavigationBridgeExpo.makeHostHandlers()])
      }).pipe(Effect.scoped)
    )
  })
})
