import type { Layer, Scope } from 'effect'
import { Effect, Logger } from 'effect'

/**
 * Generic logger-capture test fixture. Replaces Effect's default
 * `Logger` with one that pushes every entry into a shared array, so
 * tests can run scoped programs and assert on what got logged.
 *
 * Re-exported as the `LoggingLayerTest` namespace from
 * `kitchen-sink/test`. Idiomatic use:
 *
 * ```ts
 * import { LoggingLayerTest } from 'kitchen-sink/test'
 *
 * test('warns on bad input', async () => {
 *   const logs: LoggingLayerTest.CapturedLog[] = []
 *   await LoggingLayerTest.runScoped(program, logs)
 *   LoggingLayerTest.expectWarningContaining(logs, 'bad input')
 * })
 * ```
 */

/** One captured log entry — the log level label and rendered message. */
interface CapturedLog {
  readonly level: string
  readonly message: string
}

/**
 * Layer that replaces the default Effect logger with one that pushes
 * each log entry into the supplied {@link sink}. The replacement
 * propagates via FiberRef so any forked fiber inherits the same
 * sink.
 */
const make = (): { layer: Layer.Layer<never, never, never>; logSink: CapturedLog[] } => {
  const logSink: CapturedLog[] = []
  const layer = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message }) => {
      logSink.push({ level: logLevel.label, message: String(message) })
    })
  )
  return { layer, logSink }
}

/**
 * Wrap a scoped Effect program with the capturing-logger layer and
 * run it as a Promise. Tests build the program inline (with
 * `Effect.gen` and any other primitives) and pass it here — the
 * helper is just `Effect.scoped + Effect.provide(layer) + runPromise`
 * boilerplate.
 *
 * Scope close (when the program resolves) interrupts any forked
 * fiber and detaches platform listeners through their
 * `Effect.acquireRelease` chains.
 */
const runScoped = <A>(
  program: Effect.Effect<A, never, Scope.Scope>
): { promise: Promise<A>; logSink: CapturedLog[] } => {
  const { layer, logSink } = make()

  return { promise: Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer))), logSink }
}

/**
 * Assert that {@link logs} contains at least one WARN entry whose
 * message includes `substring`. Throws with the full captured log
 * when no match is found, which keeps the failure message debuggable.
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

export { expectWarningContaining, make, runScoped }
export type { CapturedLog }
