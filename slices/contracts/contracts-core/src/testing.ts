import { Effect, ManagedRuntime } from 'effect'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { _unsafeResetEffectRuntime, setEffectRuntime } from './effect-runtime-global.ts'

/**
 * Test helpers around the singleton Effect-runtime slot. Lives behind a
 * `contracts-core/testing` subpath so production bundles can't import them.
 *
 * @remarks
 * Generic logger-capture helpers live in `kitchen-sink/test`'s
 * `LoggingLayerTest`; the `TestPlatformAdapterLayer.make` stub lives in
 * `effect-messaging-core`.
 */

/**
 * Build a `ManagedRuntime` with a capturing logger and install it into
 * the {@link setEffectRuntime} slot. Returns the `logSink` for
 * assertions.
 *
 * @example
 * ```ts
 * let logSink: ReadonlyArray<LoggingLayerTest.CapturedLog>
 * beforeEach(() => { logSink = setTestEffectRuntimeGlobal().logSink })
 * afterEach(_unsafeResetEffectRuntime)
 * ```
 *
 * @remarks
 * Pair with {@link _unsafeResetEffectRuntime} in `afterEach` to clear
 * the module-scoped slot between tests.
 */
const setTestEffectRuntimeGlobal = (): { readonly logSink: LoggingLayerTest.CapturedLog[] } => {
  const { layer: loggingLayer, logSink } = LoggingLayerTest.make()
  const managed = ManagedRuntime.make(loggingLayer)
  const runtime = Effect.runSync(managed.runtimeEffect)
  setEffectRuntime(runtime)
  return { logSink }
}

export { _unsafeResetEffectRuntime, setTestEffectRuntimeGlobal }
