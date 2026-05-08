import { Effect, ManagedRuntime } from 'effect'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { _unsafeResetEffectRuntime, setEffectRuntime } from './effect-runtime-global.ts'

/**
 * Wildflower-specific test helpers around the singleton Effect-runtime
 * slot. The slot itself is wildflower's design choice (one runtime per
 * loaded bundle; logger / services threaded through it); generic
 * logger-capture helpers live in `kitchen-sink/test`'s
 * `LoggingLayerTest` namespace, and the
 * `TestPlatformAdapterLayer.make` stub for `PlatformAdapter` lives in
 * `effect-messaging-core` so any package can use them without pulling
 * in this slice's runtime convention.
 *
 * Lives behind the `contracts-core/testing` subpath rather than the
 * main barrel: pulling these into a production bundle is a wiring
 * mistake, and the dedicated subpath makes the boundary visible to
 * readers.
 */

/**
 * Build a `ManagedRuntime` configured with the capturing logger and
 * install it into the {@link setEffectRuntime} slot. Returns the
 * `logs` sink so tests can assert against captured warnings.
 *
 * Pair with {@link _unsafeResetEffectRuntime} (re-exported here for
 * convenience) in `afterEach` to clear the slot between tests — the
 * slot is module-scoped, so leaks one test's runtime into the next.
 *
 * ```ts
 * import { setTestEffectRuntimeGlobal, _unsafeResetEffectRuntime } from 'contracts-core/testing'
 * import { LoggingLayerTest } from 'kitchen-sink/test'
 *
 * let logSink: ReadonlyArray<LoggingLayerTest.CapturedLog>
 * beforeEach(() => { logSink = setTestEffectRuntimeGlobal().logSink   })
 * afterEach(_unsafeResetEffectRuntime)
 * ```
 */
const setTestEffectRuntimeGlobal = (): { readonly logSink: LoggingLayerTest.CapturedLog[] } => {
  const { layer: loggingLayer, logSink } = LoggingLayerTest.make()
  const managed = ManagedRuntime.make(loggingLayer)
  const runtime = Effect.runSync(managed.runtimeEffect)
  setEffectRuntime(runtime)
  return { logSink }
}

export { _unsafeResetEffectRuntime, setTestEffectRuntimeGlobal }
