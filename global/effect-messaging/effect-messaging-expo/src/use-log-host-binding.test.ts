import { fc, test as fcTest } from '@fast-check/jest'
import { renderHook } from '@testing-library/react-native'
import { Effect, Layer, Logger, LogLevel as EffectLogLevel } from 'effect'
import { type HostBindings, Logging } from 'effect-messaging-core'
import * as TestPlatformAdapterLayer from 'effect-messaging-core/test'
import { expectTypeOf } from 'expect-type'
import { useLogHostBinding, type UseLogHostBindingOptions } from './use-log-host-binding.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

describe('useLogHostBinding — types', () => {
  it('returns a 1-tuple HostBindings for the Logging', () => {
    expectTypeOf(useLogHostBinding).returns.toEqualTypeOf<
      HostBindings.HostBindings<readonly [typeof Logging.LogBridge]>
    >()
  })

  it('accepts an optional onLog callback receiving the structured Log payload', () => {
    expectTypeOf<UseLogHostBindingOptions['onLog']>().toEqualTypeOf<
      ((log: Logging.LogPayload) => Effect.Effect<void>) | undefined
    >()
  })
})

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
  it('returns a 1-tuple HostBindings whose only bridge is Logging', () => {
    const { result } = renderHook(() => useLogHostBinding())
    // Identity assertion (`toBe`) — the slot must hold the canonical
    // `Logging.LogBridge` declaration, not a freshly-built look-alike.
    expect(result.current.bridges).toHaveLength(1)
    expect(result.current.bridges[0]).toBe(Logging.LogBridge)
    // The Logging is web→host only; no initial-message channel.
    expect(result.current.initialMessages).toEqual([[]])
    // No post-mount work for the log binding either.
    expect(result.current.onPageReady).toEqual([undefined])
  })

  it('memoises the binding across renders when onLog is omitted (default identity is stable)', () => {
    const { result, rerender } = renderHook(() => useLogHostBinding())
    const first = result.current
    rerender({})
    expect(result.current).toBe(first)
  })

  it('rebuilds the binding when onLog identity changes', () => {
    const onLogA = (_log: Logging.LogPayload): Effect.Effect<void> => Effect.void
    const onLogB = (_log: Logging.LogPayload): Effect.Effect<void> => Effect.void
    const { result, rerender } = renderHook(
      ({ onLog }: { readonly onLog: (log: Logging.LogPayload) => Effect.Effect<void> }) =>
        useLogHostBinding({ onLog }),
      { initialProps: { onLog: onLogA } }
    )
    const first = result.current
    rerender({ onLog: onLogB })
    expect(result.current).not.toBe(first)
  })

  it('forwards the decoded {level, payload} to a custom onLog when provided', async () => {
    const received: Logging.LogPayload[] = []
    const onLog = (msg: Logging.LogPayload): Effect.Effect<void> =>
      Effect.sync(() => {
        received.push(msg)
      })
    const { result } = renderHook(() => useLogHostBinding({ onLog }))
    const handlers = result.current.handlers[0]
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
      const handlers = result.current.handlers[0]
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
      const handlers = result.current.handlers[0]
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
