import { Effect, Logger, ManagedRuntime, Runtime } from 'effect'
import { afterEach, describe, expect, test } from 'vite-plus/test'
import * as EffectRuntimeGlobal from '../src/effect-runtime-global.ts'

afterEach(async () => {
  await EffectRuntimeGlobal._unsafeResetEffectRuntime()
})

describe('Effect runtime slot', () => {
  test('getEffectRuntimeOrThrow throws before any setEffectRuntime call', () => {
    expect(() => EffectRuntimeGlobal.getEffectRuntimeOrThrow()).toThrow(/runtime not initialized/)
  })

  test('setEffectRuntime then getEffectRuntimeOrThrow returns the runtime', () => {
    EffectRuntimeGlobal.setEffectRuntime(Runtime.defaultRuntime)
    expect(EffectRuntimeGlobal.getEffectRuntimeOrThrow()).toBe(Runtime.defaultRuntime)
  })

  test('the installed runtime is the same one consumers actually run against', () => {
    const captured: string[] = []
    const captureLogger = Logger.make(({ message }) => {
      captured.push(String(message))
    })
    const managed = ManagedRuntime.make(Logger.replace(Logger.defaultLogger, captureLogger))
    const runtime = Effect.runSync(managed.runtimeEffect)
    EffectRuntimeGlobal.setEffectRuntime(runtime)

    Runtime.runSync(EffectRuntimeGlobal.getEffectRuntimeOrThrow())(Effect.logWarning('hello'))
    expect(captured.some((m) => m.includes('hello'))).toBe(true)
  })
})
