import type { Layer, Scope } from 'effect'
import { Effect, Logger } from 'effect'

/** One captured log entry. */
interface CapturedLog {
  readonly level: string
  readonly message: string
}

/**
 * Build a logger-replacement layer paired with a fresh capture array.
 *
 * @returns `{ layer, logSink }` — `layer` swaps the default logger for one
 * that pushes into `logSink`.
 *
 * @example
 * ```ts
 * const { layer, logSink } = LoggingLayerTest.make()
 * Effect.runSync(program.pipe(Effect.provide(layer)))
 * LoggingLayerTest.expectWarningContaining(logSink, 'bad input')
 * ```
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
 * Wrap a scoped Effect program with the capturing-logger layer and run
 * it as a Promise. Equivalent to
 * `Effect.scoped + Effect.provide(layer) + runPromise`.
 */
const runScoped = <A>(
  program: Effect.Effect<A, never, Scope.Scope>
): { promise: Promise<A>; logSink: CapturedLog[] } => {
  const { layer, logSink } = make()

  return { promise: Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer))), logSink }
}

/** Assert that `logs` contains a WARN entry whose message includes `substring`. */
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
