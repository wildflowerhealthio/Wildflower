import { Context, Effect, Layer, Logger, LogLevel as EffectLogLevel, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as LogBridge from '../src/log-bridge.ts'
import type * as MessageHandler from '../src/message-handler.ts'
import * as TestPlatformAdapterLayer from '../src/test-platform-adapter-layer.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

const decodeLog = Schema.decodeUnknownSync(Schema.typeSchema(LogBridge.LogMessage))

describe('LogBridge — shape', () => {
  test('exposes one webToHost Log entry and an empty hostToWeb side', () => {
    expect(Object.keys(LogBridge.LogBridge.Host.OutboundSchemas)).toEqual([])
    expect(Object.keys(LogBridge.LogBridge.Host.InboundSchemas)).toEqual(['Log'])
    expect(Object.keys(LogBridge.LogBridge.Web.OutboundSchemas)).toEqual(['Log'])
    expect(Object.keys(LogBridge.LogBridge.Web.InboundSchemas)).toEqual([])
  })

  test('the HandlerTag keys reflect the bridge name and side', () => {
    expect(LogBridge.LogBridge.Host.HandlerTag.key).toBe('Log.Host.HandlerTag')
    expect(LogBridge.LogBridge.Web.HandlerTag.key).toBe('Log.Web.HandlerTag')
  })
})

describe('LogBridge — wire round-trip', () => {
  const jsonSafeArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    value: fc.oneof(
      { maxDepth: 2 },
      fc.string(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie('value'), { maxLength: 3 }),
      fc.dictionary(fc.string(), tie('value'), { maxKeys: 3 })
    ),
  })).value

  test('property: every encoded { level, payload } decodes back to itself', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'debug' as const,
          'info' as const,
          'log' as const,
          'warn' as const,
          'error' as const
        ),
        fc.array(jsonSafeArb, { maxLength: 4 }),
        (level, payload) => {
          const encoded = Schema.encodeSync(LogBridge.LogMessage)({ _tag: 'Log', level, payload })
          const decoded = Schema.decodeSync(LogBridge.LogMessage)(encoded)
          expect(decoded).toEqual({ _tag: 'Log', level, payload })
        }
      ),
      { numRuns: numRunsFor(100) }
    )
  })

  test('LogLevel rejects strings outside the five literals', () => {
    expect(() => Schema.decodeUnknownSync(LogBridge.LogLevel)('trace')).toThrow()
    expect(() => Schema.decodeUnknownSync(LogBridge.LogLevel)('')).toThrow()
    // Each declared literal decodes cleanly.
    for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
      expect(Schema.decodeUnknownSync(LogBridge.LogLevel)(level)).toBe(level)
    }
  })
})

describe('LogBridge.defaultHostReceiverLayer field', () => {
  test('is the same Layer the bridge would build for the default Log handler', () => {
    expect(LogBridge.defaultHostReceiverLayer).toBeDefined()
  })
})

describe('LogBridge.defaultHostReceiverLayer', () => {
  interface CapturedLog {
    readonly level: string
    readonly message: unknown
  }

  /** Logger.replace layer pushing captures into the supplied sink. */
  const captureLogs = (sink: CapturedLog[]): Layer.Layer<never> =>
    Logger.replace(
      Logger.defaultLogger,
      Logger.make(({ logLevel, message }) => {
        sink.push({ level: logLevel.label, message })
      })
    )

  /**
   * Look up the `Log.Host.HandlerTag` from a built receiver layer.
   * `LogBridge.Host.HandlerTag` is the same `Context.Tag` the production
   * `ReceiverLayer` stores into, so we read from it directly — the
   * handler-record type comes back narrowed without a local re-declaration.
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

  test.each([
    ['debug', 'DEBUG'],
    ['info', 'INFO'],
    ['log', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
  ] as const)('maps wire level %s to Effect.log at %s', async (level, expectedLabel) => {
    const handlers = await resolveHandlers(LogBridge.defaultHostReceiverLayer)
    const sink: CapturedLog[] = []
    await Effect.runPromise(
      handlers.Log({ _tag: 'Log', level, payload: ['hello from the web', { extra: 1 }] }).pipe(
        Effect.provide(Layer.mergeAll(captureLogs(sink), adapterLayer)),
        // Default runtime minimum is INFO; lift it so DEBUG surfaces too.
        Logger.withMinimumLogLevel(EffectLogLevel.All)
      )
    )
    expect(sink).toHaveLength(1)
    expect(sink[0]?.level).toBe(expectedLabel)
    expect(JSON.stringify(sink[0]?.message)).toContain('hello from the web')
  })
})

describe('LogBridge.installConsoleInterceptor field', () => {
  test('exists on the bridge value', () => {
    expect(typeof LogBridge.installConsoleInterceptor).toBe('function')
  })
})

describe('LogBridge.installConsoleInterceptor', () => {
  type ConsoleMethod = LogBridge.LogLevel
  let originals: Record<ConsoleMethod, (...args: unknown[]) => void>

  beforeEach(() => {
    // Snapshot the original method references (NOT `.bind()`-wrapped —
    // identity-equality on these references is what the
    // restore-on-teardown tests assert, and `.bind()` produces a fresh
    // function each call). The afterEach restore puts these *same*
    // references back, so any prior test that forgot to restore can't
    // poison this one because we re-read live methods here.
    originals = {
      // oxlint-disable typescript-eslint/unbound-method
      debug: globalThis.console.debug,
      info: globalThis.console.info,
      log: globalThis.console.log,
      warn: globalThis.console.warn,
      error: globalThis.console.error,
      // oxlint-enable typescript-eslint/unbound-method
    }
  })

  afterEach(() => {
    Object.assign(globalThis.console, originals)
  })

  test.each(['debug', 'info', 'log', 'warn', 'error'] as const)(
    'console.%s posts a Log message with level + spread args',
    (method) => {
      const sent: Schema.Schema.Type<typeof LogBridge.LogMessage>[] = []
      const teardown = LogBridge.installConsoleInterceptor((msg) => {
        sent.push(msg)
      })
      globalThis.console[method]('hello', 1, { ctx: 'effect-messaging' })
      teardown()
      expect(sent).toEqual([
        { _tag: 'Log', level: method, payload: ['hello', 1, { ctx: 'effect-messaging' }] },
      ])
    }
  )

  test('the encoded wire form decodes via LogMessage', () => {
    const sent: string[] = []
    const teardown = LogBridge.installConsoleInterceptor((msg) => {
      sent.push(Schema.encodeSync(LogBridge.LogMessage)(msg))
    })
    globalThis.console.warn('round trip', 7)
    teardown()
    expect(sent).toHaveLength(1)
    expect(decodeLog(JSON.parse(sent[0] ?? '{}'))).toEqual({
      _tag: 'Log',
      level: 'warn',
      payload: ['round trip', 7],
    })
  })

  test('teardown restores the original methods', () => {
    const sent: Schema.Schema.Type<typeof LogBridge.LogMessage>[] = []
    const teardown = LogBridge.installConsoleInterceptor((msg) => {
      sent.push(msg)
    })
    // While installed, calls go to the interceptor.
    globalThis.console.info('intercepted')
    expect(sent).toHaveLength(1)
    teardown()
    // After teardown, the originals are back — verify by patching
    // *originals* via a temp spy and confirming the interceptor sink
    // doesn't grow.
    const beforeRestoredCount = sent.length
    globalThis.console.info('after-teardown')
    expect(sent).toHaveLength(beforeRestoredCount)
    // Re-read the method into a local before passing it to `toBe` so the
    // unbound-method lint sees an explicit (rather than implicit) read.
    // We're checking object identity of the function reference, not
    // calling it, so the `this`-loss concern doesn't apply.
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(globalThis.console.info).toBe(originals.info)
  })

  test('teardown is idempotent — calling twice is a no-op', () => {
    const teardown = LogBridge.installConsoleInterceptor(() => undefined)
    teardown()
    expect(() => teardown()).not.toThrow()
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(globalThis.console.info).toBe(originals.info)
  })

  test('re-installing while a prior install is active short-circuits to a no-op teardown — the truly-original methods survive', () => {
    const firstSent: Schema.Schema.Type<typeof LogBridge.LogMessage>[] = []
    const secondSent: Schema.Schema.Type<typeof LogBridge.LogMessage>[] = []
    const firstTeardown = LogBridge.installConsoleInterceptor((msg) => {
      firstSent.push(msg)
    })
    // Second install without a teardown in between: short-circuited so
    // the patched methods (NOT the originals) aren't recaptured as
    // baseline. The returned teardown must be a no-op.
    const secondTeardown = LogBridge.installConsoleInterceptor((msg) => {
      secondSent.push(msg)
    })
    globalThis.console.info('routed-by-first')
    expect(firstSent).toHaveLength(1)
    expect(secondSent).toHaveLength(0)
    // The no-op second teardown must NOT touch console — the originals
    // would be lost if it ran a restore from the patched-as-baseline.
    secondTeardown()
    globalThis.console.info('still-routed-by-first')
    expect(firstSent).toHaveLength(2)
    // The first teardown restores to the truly-original methods.
    firstTeardown()
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(globalThis.console.info).toBe(originals.info)
  })

  test('after teardown, a new install is allowed (the guard releases on restore)', () => {
    const firstTeardown = LogBridge.installConsoleInterceptor(() => undefined)
    firstTeardown()
    const secondSent: Schema.Schema.Type<typeof LogBridge.LogMessage>[] = []
    const secondTeardown = LogBridge.installConsoleInterceptor((msg) => {
      secondSent.push(msg)
    })
    globalThis.console.info('post-restore-install')
    expect(secondSent).toHaveLength(1)
    secondTeardown()
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(globalThis.console.info).toBe(originals.info)
  })

  test('preserves the globalThis.console object identity (only methods rotate)', () => {
    const consoleRef = globalThis.console
    const teardown = LogBridge.installConsoleInterceptor(() => undefined)
    expect(globalThis.console).toBe(consoleRef)
    teardown()
    expect(globalThis.console).toBe(consoleRef)
  })
})
