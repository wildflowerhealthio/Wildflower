import type { Layer } from 'effect'
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
 * expect(logSink).toEqual([{ level: 'WARN', message: 'bad input' }])
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
 * Pipe step that installs the capturing logger over `program` and
 * runs `logExpect` against the captured entries when the program
 * ends — including failure, defect, and interruption — via
 * `Effect.ensuring`. Caller composes with `Effect.scoped` and
 * `Effect.runPromise`.
 *
 * @example
 * ```ts
 * await Effect.runPromise(
 *   program.pipe(
 *     LoggingLayerTest.expectToLog((logs) => {
 *       expect(logs).toEqual([{ level: 'WARN', message: 'bad input' }])
 *     }),
 *     Effect.scoped
 *   )
 * )
 * ```
 */
const expectToLog =
  (logExpect: (logs: CapturedLog[]) => void) =>
  <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const { layer, logSink } = make()
    return program.pipe(
      Effect.ensuring(Effect.sync(() => logExpect(logSink))),
      Effect.provide(layer)
    )
  }

export { expectToLog, make }
export type { CapturedLog }
