import { fc, test as fcTest } from '@fast-check/jest'
import { renderHook } from '@testing-library/react-native'
import { Context, Effect, Layer, Logger, LogLevel as EffectLogLevel } from 'effect'
import {
  type HostBinding,
  LogBridge,
  type MessageHandler,
  TestPlatformAdapterLayer,
} from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import { useLogHostBinding, type UseLogHostBindingOptions } from './use-log-host-binding.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

describe('useLogHostBinding — types', () => {
  it('returns a HostBinding for the LogBridge', () => {
    expectTypeOf(useLogHostBinding).returns.toEqualTypeOf<
      HostBinding.HostBinding<typeof LogBridge.LogBridge>
    >()
  })

  it('accepts an optional onLog callback receiving the structured Log payload', () => {
    expectTypeOf<UseLogHostBindingOptions['onLog']>().toEqualTypeOf<
      ((log: LogBridge.LogPayload) => Effect.Effect<void>) | undefined
    >()
  })
})

/**
 * Resolve the LogBridge's `Log.Host.HandlerTag` from a built receiver
 * layer. `LogBridge.LogBridge.Host.HandlerTag` is the same `Context.Tag`
 * the production `ReceiverLayer` stores into, so we read from it directly —
 * the handler-record type comes back narrowed without a local re-declaration.
 */
const resolveHandlers = async (
  layer: Layer.Layer<MessageHandler.TagId<'Log', 'Host'>>
): Promise<Context.Tag.Service<typeof LogBridge.LogBridge.Host.HandlerTag>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(layer)
        return Context.get(ctx, LogBridge.LogBridge.Host.HandlerTag)
      })
    )
  )

interface CapturedLog {
  readonly level: EffectLogLevel.LogLevel['label']
  readonly message: unknown
}

/** Replace the default Effect logger with one that pushes into `sink`. */
const captureLogs = (sink: CapturedLog[]): Layer.Layer<never> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message }) => {
      sink.push({ level: logLevel.label, message })
    })
  )

describe('useLogHostBinding — runtime', () => {
  it('returns a HostBinding whose bridge is LogBridge', () => {
    const { result } = renderHook(() => useLogHostBinding())
    expect(result.current.bridge).toBe(LogBridge.LogBridge)
    // The LogBridge is web→host only; no initial-message channel.
    expect(result.current.initialMessages).toBeUndefined()
  })

  it('memoises the binding across renders when onLog is omitted (default identity is stable)', () => {
    const { result, rerender } = renderHook(() => useLogHostBinding())
    const first = result.current
    rerender({})
    expect(result.current).toBe(first)
  })

  it('rebuilds the binding when onLog identity changes', () => {
    const onLogA = (_log: LogBridge.LogPayload): Effect.Effect<void> => Effect.void
    const onLogB = (_log: LogBridge.LogPayload): Effect.Effect<void> => Effect.void
    const { result, rerender } = renderHook(
      ({ onLog }: { readonly onLog: (log: LogBridge.LogPayload) => Effect.Effect<void> }) =>
        useLogHostBinding({ onLog }),
      { initialProps: { onLog: onLogA } }
    )
    const first = result.current
    rerender({ onLog: onLogB })
    expect(result.current).not.toBe(first)
  })

  it('forwards the decoded {level, payload} to a custom onLog when provided', async () => {
    const received: LogBridge.LogPayload[] = []
    const onLog = (msg: LogBridge.LogPayload): Effect.Effect<void> =>
      Effect.sync(() => {
        received.push(msg)
      })
    const { result } = renderHook(() => useLogHostBinding({ onLog }))
    const handlers = await resolveHandlers(result.current.receiverLayer)
    await Effect.runPromise(
      handlers
        .Log({ _tag: 'Log', level: 'info', payload: ['first', 1] })
        .pipe(Effect.provide(adapterLayer))
    )
    await Effect.runPromise(
      handlers
        .Log({ _tag: 'Log', level: 'warn', payload: ['second'] })
        .pipe(Effect.provide(adapterLayer))
    )
    expect(received).toEqual([
      { _tag: 'Log', level: 'info', payload: ['first', 1] },
      { _tag: 'Log', level: 'warn', payload: ['second'] },
    ])
  })

  // Level→logger label mapping pinned crisply by the enumerated table.
  // (The `fcTest.prop` below complements it by varying the payload.)
  it.each([
    ['debug', 'DEBUG'],
    ['info', 'INFO'],
    ['log', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
  ] as const)(
    'default onLog routes wire level %s through Effect.log at %s',
    async (level, expectedLabel) => {
      const { result } = renderHook(() => useLogHostBinding())
      const handlers = await resolveHandlers(result.current.receiverLayer)
      const sink: CapturedLog[] = []
      await Effect.runPromise(
        handlers.Log({ _tag: 'Log', level, payload: ['hello from the spa'] }).pipe(
          Effect.provide(Layer.mergeAll(captureLogs(sink), adapterLayer)),
          // Default runtime minimum is INFO; lift it so DEBUG surfaces too.
          Logger.withMinimumLogLevel(EffectLogLevel.All)
        )
      )
      expect(sink).toHaveLength(1)
      expect(sink[0]?.level).toBe(expectedLabel)
      expect(JSON.stringify(sink[0]?.message)).toContain('hello from the spa')
    }
  )

  // Property: the variadic `...payload` is preserved across multi-element
  // arrays. The enumerated test above covers the level→label mapping
  // (against a single-element payload); this one exercises the spread on
  // payloads of varying arity — the production scenario where a page-side
  // `console.warn('a', 1, { b: 2 })` ships every argument verbatim.
  fcTest.prop({
    level: fc.constantFrom(
      'debug' as const,
      'info' as const,
      'log' as const,
      'warn' as const,
      'error' as const
    ),
    payload: fc.array(fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)), {
      maxLength: 4,
    }),
  })(
    'default onLog spreads every payload element through Effect.log',
    async ({ level, payload }) => {
      const { result } = renderHook(() => useLogHostBinding())
      const handlers = await resolveHandlers(result.current.receiverLayer)
      const sink: CapturedLog[] = []
      await Effect.runPromise(
        handlers
          .Log({ _tag: 'Log', level, payload })
          .pipe(
            Effect.provide(Layer.mergeAll(captureLogs(sink), adapterLayer)),
            Logger.withMinimumLogLevel(EffectLogLevel.All)
          )
      )
      // Empty payload still produces a single (empty-message) log entry —
      // `Effect.log<Level>()` emits with an empty message, not nothing.
      expect(sink).toHaveLength(1)
      // Each non-null primitive (string/integer/boolean) must round-trip
      // through the message — `null` and the empty case give nothing to
      // assert against, so we skip them.
      const captured = JSON.stringify(sink[0]?.message)
      for (const entry of payload) {
        if (entry === null) continue
        expect(captured).toContain(JSON.stringify(entry))
      }
    }
  )
})
