import type { Layer, Scope } from 'effect'
import { Effect, Logger, ManagedRuntime } from 'effect'
import { _unsafeResetInteropRuntime, setInteropRuntime } from './runtime.ts'

/**
 * Test helpers for interop consumers — capturing logger, scoped-program
 * runner, and a one-call test runtime installer for the
 * {@link setInteropRuntime} slot.
 *
 * Lives behind the `interop-core/testing` subpath rather than the main
 * barrel: pulling these into a production bundle is a wiring mistake,
 * and the dedicated subpath makes the boundary visible to readers.
 */

type CapturedLog = { readonly level: string; readonly message: string }

/**
 * Effect logger that pushes every log call into a shared array. Pair
 * with {@link makeCaptureLoggerLayer} (or {@link runScopedWithLogger})
 * to swap the default logger for one that surfaces structured events
 * to test assertions.
 */
const makeCaptureLogger = (sink: CapturedLog[]): Logger.Logger<unknown, void> =>
  Logger.make(({ logLevel, message }) => {
    sink.push({ level: logLevel.label, message: String(message) })
  })

/**
 * Layer that replaces the default Effect logger with a capturing
 * logger writing into the supplied sink. The replacement propagates via
 * FiberRef so any forked dispatch fiber, sync `Effect.logWarning` at
 * construction, etc. all hit the same array.
 */
const makeCaptureLoggerLayer = (sink: CapturedLog[]): Layer.Layer<never, never, never> =>
  Logger.replace(Logger.defaultLogger, makeCaptureLogger(sink))

/**
 * Assert that `logs` contains at least one WARN entry whose message
 * includes `substring`. Throws with the full captured log when no
 * match is found, which keeps the failure message debuggable.
 */
const expectWarningContaining = (logs: ReadonlyArray<CapturedLog>, substring: string): void => {
  const match = logs.find((l) => l.level === 'WARN' && l.message.includes(substring))
  if (match === undefined) {
    throw new Error(
      `expected a WARN log containing "${substring}", got:\n` +
        logs.map((l) => `  [${l.level}] ${l.message}`).join('\n')
    )
  }
}

/**
 * Wrap a scoped Effect program with the capturing logger and run it as
 * a Promise. Tests build the program inline (with `Effect.gen` and the
 * transport / dispatch primitives) and pass it here — the helper is
 * just `Effect.scoped + Effect.provide(loggerLayer) + runPromise`
 * boilerplate.
 *
 * Scope close (when the program resolves) interrupts any forked fiber
 * and detaches platform listeners through their `Effect.acquireRelease`
 * chains.
 */
const runScopedWithLogger = <A>(
  program: Effect.Effect<A, never, Scope.Scope>,
  logs: CapturedLog[]
): Promise<A> =>
  Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(makeCaptureLoggerLayer(logs))))

/**
 * Build a `ManagedRuntime` configured with the capturing logger and
 * install it into the interop runtime slot. Returns the `logs` sink so
 * tests can assert against captured warnings.
 *
 * Pair with {@link _unsafeResetInteropRuntime} (re-exported here for
 * convenience) in `afterEach` to clear the slot between tests — the
 * slot is module-scoped, so leaks one test's runtime into the next.
 *
 * ```ts
 * import { installTestInteropRuntime, _unsafeResetInteropRuntime, expectWarningContaining }
 *   from 'interop-core/testing'
 *
 * let logs: ReadonlyArray<CapturedLog>
 * beforeEach(() => { logs = installTestInteropRuntime().logs })
 * afterEach(_unsafeResetInteropRuntime)
 * ```
 */
const installTestInteropRuntime = (): { readonly logs: CapturedLog[] } => {
  const logs: CapturedLog[] = []
  const managed = ManagedRuntime.make(makeCaptureLoggerLayer(logs))
  const runtime = Effect.runSync(managed.runtimeEffect)
  setInteropRuntime(runtime)
  return { logs }
}

export {
  _unsafeResetInteropRuntime,
  type CapturedLog,
  expectWarningContaining,
  installTestInteropRuntime,
  makeCaptureLogger,
  makeCaptureLoggerLayer,
  runScopedWithLogger,
}
