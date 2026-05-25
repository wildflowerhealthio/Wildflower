import { fc, test as fcTest } from '@fast-check/jest'
import { Context, Effect, Layer, Logger, LogLevel, Schema } from 'effect'
import {
  BridgeTransport,
  type MessageHandler,
  TestPlatformAdapterLayer,
} from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { NavigationBridge } from 'navigation-core'
import { type LogMessage, NavigationBridgeExpo } from './index.ts'

// Type-only assertions on `ReceiverLayer`'s signature. Hoisted to module
// scope so the type check fires at file load — `expect-type` is purely
// compile-time, so wrapping these in `it(...)` would have Jest report them
// as passing whether or not the type-level invariant holds.
expectTypeOf(NavigationBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
  Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>>
>()
expectTypeOf(NavigationBridgeExpo.ReceiverLayer)
  .parameter(0)
  .toEqualTypeOf<((route: { pathname: string; canGoBack: boolean }) => void) | undefined>()
expectTypeOf(NavigationBridgeExpo.ReceiverLayer)
  .parameter(1)
  .toEqualTypeOf<((log: LogMessage) => Effect.Effect<void>) | undefined>()

/**
 * Resolve the bridge's `Navigation.Host.HandlerTag` from a built receiver
 * layer. `NavigationBridge.Host.HandlerTag` is the same `Context.Tag` the
 * production `ReceiverLayer` stores into, so we read from it directly —
 * the handler-record type comes back narrowed without a local
 * re-declaration.
 */
const resolveHandlers = async (
  layer: Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>>
): Promise<Context.Tag.Service<typeof NavigationBridge.Host.HandlerTag>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(layer)
        return Context.get(ctx, NavigationBridge.Host.HandlerTag)
      })
    )
  )

describe('NavigationBridgeExpo.ReceiverLayer (RouteChanged handler)', () => {
  fcTest.prop({
    pathname: fc.webPath(),
    canGoBack: fc.boolean(),
  })(
    'forwards the decoded {pathname, canGoBack} payload to onRouteChanged',
    async ({ pathname, canGoBack }) => {
      const onRouteChanged = jest.fn()
      const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer(onRouteChanged))
      await Effect.runPromise(handlers.RouteChanged({ _tag: 'RouteChanged', pathname, canGoBack }))
      expect(onRouteChanged).toHaveBeenCalledTimes(1)
      expect(onRouteChanged).toHaveBeenCalledWith({ pathname, canGoBack })
    }
  )

  it('does not crash when onRouteChanged is omitted (dispatch fiber must keep draining)', async () => {
    const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer())
    await expect(
      Effect.runPromise(
        handlers.RouteChanged({ _tag: 'RouteChanged', pathname: '/foo', canGoBack: true })
      )
    ).resolves.toBeUndefined()
  })
})

describe('NavigationBridgeExpo.ReceiverLayer (Log handler)', () => {
  it('forwards the decoded {level, payload} to a custom onLog when provided', async () => {
    const received: LogMessage[] = []
    const onLog = (msg: LogMessage): Effect.Effect<void> =>
      Effect.sync(() => {
        received.push(msg)
      })
    const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer(undefined, onLog))
    await Effect.runPromise(handlers.Log({ _tag: 'Log', level: 'info', payload: ['first', 1] }))
    await Effect.runPromise(handlers.Log({ _tag: 'Log', level: 'warn', payload: ['second'] }))
    expect(received).toEqual([
      { level: 'info', payload: ['first', 1] },
      { level: 'warn', payload: ['second'] },
    ])
  })

  it.each([
    ['debug', 'DEBUG'],
    ['info', 'INFO'],
    ['log', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
  ] as const)(
    'falls back to Effect.log at level %s → %s when onLog is omitted (per ReceiverLayer JSDoc)',
    async (level, expectedLabel) => {
      const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer())
      await Effect.runPromise(
        handlers.Log({ _tag: 'Log', level, payload: ['hello from the spa'] }).pipe(
          LoggingLayerTest.expectToLog((logs) => {
            expect(logs).toHaveLength(1)
            expect(logs[0]?.level).toBe(expectedLabel)
            expect(logs[0]?.message).toContain('hello from the spa')
          }),
          // Default runtime minimum is INFO; lift it so DEBUG surfaces too.
          Logger.withMinimumLogLevel(LogLevel.All)
        )
      )
    }
  )

  it('keeps the BridgeTransport dispatch fiber draining after no-op handlers run', async () => {
    // Real `BridgeTransport.make` on the Host side with `ReceiverLayer()` —
    // both callbacks omitted, so `RouteChanged` short-circuits and `Log`
    // routes through the Effect logger fallback. We then enqueue a
    // RouteChanged + a Log via the live bareSender (the actual dispatch
    // path the WebView's `onMessage` exercises in prod) and await
    // `transport.flushed`, which only resolves once every queued message
    // has been processed. A fiber crash during dispatch would surface
    // here as a rejected promise.
    const { layer: adapterLayer, liveBareSenderRef } = TestPlatformAdapterLayer.make({
      captureBareSenderLive: true,
    })
    const routeChangedEncoded = Schema.encodeSync(NavigationBridge.MessageSchemas.RouteChanged)({
      _tag: 'RouteChanged',
      pathname: '/a',
      canGoBack: false,
    })
    const logEncoded = Schema.encodeSync(NavigationBridge.MessageSchemas.Log)({
      _tag: 'Log',
      level: 'info',
      payload: ['drain me'],
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* BridgeTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [NavigationBridgeExpo.ReceiverLayer()] as const,
          side: 'Host',
        }).pipe(Effect.provide(adapterLayer))
        if (liveBareSenderRef.current === null) {
          throw new Error('liveBareSenderRef not captured')
        }
        yield* liveBareSenderRef.current(routeChangedEncoded)
        yield* liveBareSenderRef.current(logEncoded)
        yield* liveBareSenderRef.current(routeChangedEncoded)
        yield* transport.flushed
      }).pipe(Effect.scoped)
    )
  })
})
