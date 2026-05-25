import { fc, test as fcTest } from '@fast-check/jest'
import { Context, Effect, Fiber, Layer, Logger, LogLevel } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import { type LogMessage, NavigationBridgeExpo } from './index.ts'

describe('NavigationBridgeExpo.ReceiverLayer', () => {
  it('returns a Layer providing the Navigation host handler tag', () => {
    expectTypeOf(NavigationBridgeExpo.ReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>>
    >()
  })

  it('accepts an optional onRouteChanged callback', () => {
    expectTypeOf(NavigationBridgeExpo.ReceiverLayer)
      .parameter(0)
      .toEqualTypeOf<((route: { pathname: string; canGoBack: boolean }) => void) | undefined>()
  })

  it('accepts an optional onLog callback receiving the structured Log payload', () => {
    expectTypeOf(NavigationBridgeExpo.ReceiverLayer)
      .parameter(1)
      .toEqualTypeOf<((log: LogMessage) => Effect.Effect<void>) | undefined>()
  })
})

/**
 * Resolve the bridge's `Navigation.Host.HandlerTag` from a built receiver
 * layer. Returns the inbound handlers record (which the production
 * `NavigationBridge.Host.ReceiverLayer` stores via `Layer.succeed`).
 */
interface NavigationHostHandlers {
  readonly RouteChanged: (msg: {
    readonly pathname: string
    readonly canGoBack: boolean
  }) => Effect.Effect<void>
  readonly Log: (msg: {
    readonly level: LogMessage['level']
    readonly payload: readonly unknown[]
  }) => Effect.Effect<void>
}

const resolveHandlers = async (
  layer: Layer.Layer<MessageHandler.TagId<'Navigation', 'Host'>>
): Promise<NavigationHostHandlers> => {
  // Build the layer's Context and look up the handler tag by id. The tag
  // is created inside `Bridge.make({ name: 'Navigation', ... })` with id
  // `Navigation.Host.HandlerTag`; we re-derive the matching tag instance
  // here so we can read out the registered handlers.
  const tag = Context.GenericTag<
    MessageHandler.TagId<'Navigation', 'Host'>,
    NavigationHostHandlers
  >('Navigation.Host.HandlerTag')
  return await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(layer)
        return Context.get(ctx, tag)
      })
    )
  )
}

describe('NavigationBridgeExpo.ReceiverLayer (RouteChanged handler)', () => {
  fcTest.prop({
    pathname: fc.webPath(),
    canGoBack: fc.boolean(),
  })(
    'forwards the decoded {pathname, canGoBack} payload to onRouteChanged',
    async ({ pathname, canGoBack }) => {
      const onRouteChanged = jest.fn()
      const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer(onRouteChanged))
      await Effect.runPromise(handlers.RouteChanged({ pathname, canGoBack }))
      expect(onRouteChanged).toHaveBeenCalledTimes(1)
      expect(onRouteChanged).toHaveBeenCalledWith({ pathname, canGoBack })
    }
  )

  it('does not crash when onRouteChanged is omitted (dispatch fiber must keep draining)', async () => {
    const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer())
    await expect(
      Effect.runPromise(handlers.RouteChanged({ pathname: '/foo', canGoBack: true }))
    ).resolves.toBeUndefined()
  })
})

interface CapturedLog {
  readonly level: LogLevel.LogLevel['label']
  readonly message: unknown
}

/**
 * Replace the default Effect logger with one that pushes into `sink`.
 * Mirrors the in-tree helper at
 * `global/kitchen-sink/src/test/logging-layer-test.ts` so the navigation
 * test stays self-contained (no extra workspace dep).
 */
const captureLogs = (sink: CapturedLog[]): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message }) => {
      sink.push({ level: logLevel.label, message })
    })
  )

describe('NavigationBridgeExpo.ReceiverLayer (Log handler)', () => {
  it('forwards the decoded {level, payload} to a custom onLog when provided', async () => {
    const received: LogMessage[] = []
    const onLog = (msg: LogMessage): Effect.Effect<void> =>
      Effect.sync(() => {
        received.push(msg)
      })
    const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer(undefined, onLog))
    await Effect.runPromise(handlers.Log({ level: 'info', payload: ['first', 1] }))
    await Effect.runPromise(handlers.Log({ level: 'warn', payload: ['second'] }))
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
      const sink: CapturedLog[] = []
      await Effect.runPromise(
        handlers.Log({ level, payload: ['hello from the spa'] }).pipe(
          Effect.provide(captureLogs(sink)),
          // Default runtime minimum is INFO; lift it so DEBUG surfaces too.
          Logger.withMinimumLogLevel(LogLevel.All)
        )
      )
      expect(sink).toHaveLength(1)
      expect(sink[0]?.level).toBe(expectedLabel)
      // The Effect runtime stores `message` as either a single value or an
      // array depending on how many args were passed; JSON.stringify covers
      // both shapes.
      expect(JSON.stringify(sink[0]?.message)).toContain('hello from the spa')
    }
  )

  it('does not crash when both onRouteChanged and onLog are omitted (dispatch fiber)', async () => {
    // Both undefined → RouteChanged is a no-op, Log falls back to Effect.log.
    // Running both handlers concurrently with neither callback wired
    // pins that the dispatch path doesn't synchronously throw.
    const handlers = await resolveHandlers(NavigationBridgeExpo.ReceiverLayer())
    await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* Effect.fork(handlers.RouteChanged({ pathname: '/a', canGoBack: false }))
        const b = yield* Effect.fork(handlers.Log({ level: 'info', payload: ['b'] }))
        yield* Fiber.join(a)
        yield* Fiber.join(b)
      })
    )
  })
})
