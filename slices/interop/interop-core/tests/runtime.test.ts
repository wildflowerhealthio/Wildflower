import { Effect, Logger, ManagedRuntime, Runtime } from 'effect'
import { afterEach, describe, expect, test } from 'vite-plus/test'
import { _unsafeResetInteropRuntime, getInteropRuntime, setInteropRuntime } from '../src/runtime.ts'

afterEach(() => {
  // Reset the slot between tests so module-mutable state doesn't leak.
  // The reset is internal-only; the package barrel intentionally
  // doesn't export it.
  _unsafeResetInteropRuntime()
})

describe('interop runtime slot', () => {
  test('getInteropRuntime throws before any setInteropRuntime call', () => {
    expect(() => getInteropRuntime()).toThrow(/runtime not initialized/)
  })

  test('setInteropRuntime then getInteropRuntime returns the runtime', () => {
    setInteropRuntime(Runtime.defaultRuntime)
    expect(getInteropRuntime()).toBe(Runtime.defaultRuntime)
  })

  test('the installed runtime is the same one consumers actually run against', () => {
    // End-to-end: install a runtime whose logger captures into a sink,
    // then ask the slot for it and run an Effect.logWarning. The sink
    // sees the message — proving the slot's runtime is honoured.
    const captured: string[] = []
    const captureLogger = Logger.make(({ message }) => {
      captured.push(String(message))
    })
    const managed = ManagedRuntime.make(Logger.replace(Logger.defaultLogger, captureLogger))
    const runtime = Effect.runSync(managed.runtimeEffect)
    setInteropRuntime(runtime)

    Runtime.runSync(getInteropRuntime())(Effect.logWarning('hello'))
    expect(captured.some((m) => m.includes('hello'))).toBe(true)
  })
})
