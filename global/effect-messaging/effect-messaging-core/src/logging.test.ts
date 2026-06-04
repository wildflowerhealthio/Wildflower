import { Effect, Layer, Logger, LogLevel as EffectLogLevel, Schema, Arbitrary } from 'effect'
import * as fc from 'fast-check'
import { JsonValue } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as Logging from './logging.ts'
import * as TestPlatformAdapterLayer from './test-platform-adapter-layer.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

const decodeLog = Schema.decodeUnknownSync(Schema.typeSchema(Logging.LogMessage))

describe('Logging — shape', () => {
  test('exposes one webToHost Log entry and an empty hostToWeb side', () => {
    expect(Object.keys(Logging.LogBridge.WebToHost)).toEqual(['Log'])
    expect(Object.keys(Logging.LogBridge.HostToWeb)).toEqual([])
  })
})

describe('Logging — wire round-trip', () => {
  const jsonSafeArb = Arbitrary.make(JsonValue)

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
          const encoded = Schema.encodeSync(Logging.LogMessage)({ _tag: 'Log', level, payload })
          const decoded = Schema.decodeSync(Logging.LogMessage)(encoded)
          expect(decoded).toEqual({ _tag: 'Log', level, payload })
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('LogLevel rejects strings outside the five literals', () => {
    expect(() => Schema.decodeUnknownSync(Logging.LogLevel)('trace')).toThrow()
    expect(() => Schema.decodeUnknownSync(Logging.LogLevel)('')).toThrow()
    // Each declared literal decodes cleanly.
    for (const level of ['debug', 'info', 'log', 'warn', 'error'] as const) {
      expect(Schema.decodeUnknownSync(Logging.LogLevel)(level)).toBe(level)
    }
  })
})

describe('Logging.defaultLogHostHandlers field', () => {
  test('exposes a Log handler', () => {
    expect(typeof Logging.defaultLogHostHandlers.Log).toBe('function')
  })
})

describe('Logging.defaultLogHostHandlers', () => {
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

  test.each([
    ['debug', 'DEBUG'],
    ['info', 'INFO'],
    ['log', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
  ] as const)('maps wire level %s to Effect.log at %s', async (level, expectedLabel) => {
    const sink: CapturedLog[] = []
    await Effect.runPromise(
      Logging.defaultLogHostHandlers
        .Log({ _tag: 'Log', level, payload: ['hello from the web', { extra: 1 }] })
        .pipe(
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

describe('Logging.installConsoleInterceptor field', () => {
  test('exists on the bridge value', () => {
    expect(typeof Logging.installConsoleInterceptor).toBe('function')
  })
})

describe('Logging.installConsoleInterceptor', () => {
  type ConsoleMethod = Logging.LogLevel
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
      const sent: Schema.Schema.Type<typeof Logging.LogMessage>[] = []
      const teardown = Logging.installConsoleInterceptor((msg) => {
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
    const teardown = Logging.installConsoleInterceptor((msg) => {
      sent.push(Schema.encodeSync(Logging.LogMessage)(msg))
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
    const sent: Schema.Schema.Type<typeof Logging.LogMessage>[] = []
    const teardown = Logging.installConsoleInterceptor((msg) => {
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
    const teardown = Logging.installConsoleInterceptor(() => undefined)
    teardown()
    expect(() => teardown()).not.toThrow()
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(globalThis.console.info).toBe(originals.info)
  })

  test('re-installing while a prior install is active warns, returns a no-op teardown — the truly-original methods survive', () => {
    const firstSent: Schema.Schema.Type<typeof Logging.LogMessage>[] = []
    const secondSent: Schema.Schema.Type<typeof Logging.LogMessage>[] = []
    const firstTeardown = Logging.installConsoleInterceptor((msg) => {
      firstSent.push(msg)
    })
    // Second install without a teardown in between: short-circuited so
    // the patched methods (NOT the originals) aren't recaptured as
    // baseline. It warns (via console.warn, which the active first
    // interceptor ships onward) and returns a no-op teardown.
    const secondTeardown = Logging.installConsoleInterceptor((msg) => {
      secondSent.push(msg)
    })
    expect(firstSent).toContainEqual(
      expect.objectContaining({
        _tag: 'Log',
        level: 'warn',
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        payload: expect.arrayContaining([expect.stringContaining('already active')]),
      })
    )
    // The warning routed through the first (active) interceptor, never the second.
    expect(secondSent).toHaveLength(0)
    const firstCountAfterWarn = firstSent.length
    globalThis.console.info('routed-by-first')
    expect(firstSent).toHaveLength(firstCountAfterWarn + 1)
    // The no-op second teardown must NOT touch console — the originals
    // would be lost if it ran a restore from the patched-as-baseline.
    secondTeardown()
    globalThis.console.info('still-routed-by-first')
    expect(firstSent).toHaveLength(firstCountAfterWarn + 2)
    // The first teardown restores to the truly-original methods.
    firstTeardown()
    // oxlint-disable-next-line typescript-eslint/unbound-method
    expect(globalThis.console.info).toBe(originals.info)
  })

  test('after teardown, a new install is allowed (the guard releases on restore)', () => {
    const firstTeardown = Logging.installConsoleInterceptor(() => undefined)
    firstTeardown()
    const secondSent: Schema.Schema.Type<typeof Logging.LogMessage>[] = []
    const secondTeardown = Logging.installConsoleInterceptor((msg) => {
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
    const teardown = Logging.installConsoleInterceptor(() => undefined)
    expect(globalThis.console).toBe(consoleRef)
    teardown()
    expect(globalThis.console).toBe(consoleRef)
  })
})
