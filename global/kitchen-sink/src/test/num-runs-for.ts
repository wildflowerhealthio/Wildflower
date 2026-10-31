import { Option, pipe, Schema } from 'effect'

/**
 * The FC_RUN_SCALE value: a finite, non-negative number. The test plan
 * (`scripts/ci/test-shards.ts`, in CI and through `vp run test:changed`) sets
 * it below 1 for a branch whose changes reach no package.
 */
const RunScale = Schema.NumberFromString.pipe(Schema.finite(), Schema.nonNegative())
const decodeRunScale = Schema.decodeUnknownOption(RunScale)

/** The FC_RUN_SCALE multiplier, or `1` when it's unset or not a run scale. */
const currentRunScale = (): number =>
  pipe(
    Option.fromNullable(process.env.FC_RUN_SCALE),
    Option.flatMap(decodeRunScale),
    Option.getOrElse(() => 1)
  )

/** Default floor for {@link scaleNumRuns} and {@link numRunsFor}'s `minimum`. */
const DEFAULT_MINIMUM = 10

/**
 * Scale `base` by `multiplier`, flooring at `min(minimum, base)` so a
 * non-trivial property still runs end-to-end on a reduced run, while a test that intentionally requests fewer than `minimum` runs is left
 * untouched. A multiplier of `1.0` or higher returns `base` unchanged.
 *
 * `minimum` defaults to `10`.
 *
 * Exported for unit testing — production callers go through {@link numRunsFor}.
 */
const scaleNumRuns = (base: number, multiplier: number, minimum = DEFAULT_MINIMUM): number => {
  if (multiplier >= 1) return base
  return Math.max(Math.min(minimum, base), Math.floor(base * multiplier))
}

/** Options for {@link numRunsFor}. */
interface NumRunsForOptions {
  /** The unscaled fast-check `numRuns`, what a full-scale run requests. */
  readonly base: number
  /**
   * The floor the scaled result never drops below, unless `base` itself is
   * smaller (a deliberately tiny `base` is left untouched). Defaults to `10`.
   */
  readonly minimum?: number
}

/**
 * Scale a fast-check `numRuns` value by the FC_RUN_SCALE multiplier.
 *
 * Floors at `min(minimum, base)` so a non-trivial property still runs
 * end-to-end on a reduced run, but a test that intentionally requests fewer
 * than `minimum` runs is left untouched. `minimum` defaults to `10`.
 *
 * When FC_RUN_SCALE is unset (the default, including plain `vp test`) or
 * isn't a run scale, this returns `base` unchanged. It's read per call, so a
 * test that sets it sees the change.
 *
 * @example
 * ```ts
 * fc.assert(prop, { numRuns: numRunsFor({ base: 100 }) })
 * ```
 *
 * @example
 * ```ts
 * const REFERENCE_NUM_RUNS = numRunsFor({ base: 25, minimum: 5 })
 * ```
 */
const numRunsFor = ({ base, minimum }: NumRunsForOptions): number =>
  scaleNumRuns(base, currentRunScale(), minimum)

// `scaleNumRuns` is exported for unit testing only;
// the public `kitchen-sink/test` entry (src/test/index.ts) re-exports just
// `numRunsFor`.
export type { NumRunsForOptions }
export { numRunsFor, scaleNumRuns }
