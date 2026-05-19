import type { Queryable } from '@livestore/livestore'
import { Data, Stream } from 'effect'

import type { ControlSnapshot } from './types.ts'

interface SubscribableStore {
  subscribeStream<T>(q: Queryable<T>): Stream.Stream<T>
}

/**
 * The set of value types that pass cleanly through `Data.struct`
 * equality. Limiting `TConfig`'s fields to these statically encodes the
 * "shallow object" requirement called out in {@link WatchSnapshotsOpts}:
 * nested mutable references can't reach the dedup boundary in the first
 * place, so `Stream.changes` is guaranteed to compare structurally.
 */
type ShallowPrimitive = string | number | boolean | bigint | null | undefined

/**
 * Constraint on `TConfig` for {@link watchSnapshots}: a record whose
 * every own field is a {@link ShallowPrimitive}. Encodes the equality
 * contract at the type level so misuse is a compile error rather than a
 * runtime busy-retry.
 */
type ShallowConfig = Readonly<Record<string, ShallowPrimitive>>

/**
 * Options for {@link watchSnapshots}.
 *
 * @typeParam TRaw - The shape of the livestore query row.
 * @typeParam TConfig - Slice-specific config payload. Constrained to
 *   {@link ShallowConfig} so the `Data.struct` wrap below produces a
 *   value with complete structural-equality coverage. Nested mutable
 *   references would defeat that comparison and cause the daemon to
 *   busy-retry on every emit.
 */
interface WatchSnapshotsOpts<TRaw, TConfig extends ShallowConfig> {
  readonly store: SubscribableStore
  readonly query: Queryable<TRaw>
  /**
   * Project the raw livestore row down to a `ControlSnapshot`.
   *
   * Return `config: null` whenever the row isn't ready to drive a run
   * (missing required fields, row absent, etc.). When non-null, `config`
   * is a plain object whose fields are all shallow primitives —
   * `watchSnapshots` wraps it in `Data.struct` for the upstream
   * `Stream.changes` dedup boundary.
   *
   * The projection must include only user-controlled fields — anything
   * the daemon itself writes back (running/current* flags, error
   * messages, idle-port resets, etc.) must be excluded. Otherwise the
   * daemon's own commits change the projection and would re-enter the
   * pipeline, causing busy-retries on every error.
   */
  readonly readSnapshot: (raw: TRaw) => ControlSnapshot<TConfig>
}

/**
 * Stage 1 of the process-daemon pipeline.
 *
 * Subscribe to a livestore singleton query, project each emit to a
 * `ControlSnapshot<TConfig>`, wrap both the envelope and (when present)
 * the inner `config` in `Data.struct` so `Stream.changes` can dedup via
 * structural equality, then drop consecutive duplicates.
 *
 * @remarks
 * The library owns the `Data.struct` wrap on both layers — callers
 * return plain objects from `readSnapshot`. The `TConfig extends
 * ShallowConfig` constraint enforces the no-nested-objects rule at
 * compile time, so the structural-equality contract `Stream.changes`
 * relies on can't be silently violated by a deeply-nested projection.
 */
const watchSnapshots = <TRaw, TConfig extends ShallowConfig>(
  opts: WatchSnapshotsOpts<TRaw, TConfig>
): Stream.Stream<ControlSnapshot<TConfig>> =>
  opts.store.subscribeStream(opts.query).pipe(
    Stream.map((raw) => {
      const projected = opts.readSnapshot(raw)
      const wrappedConfig = projected.config === null ? null : Data.struct(projected.config)
      return Data.struct<ControlSnapshot<TConfig>>({
        requestedRunning: projected.requestedRunning,
        config: wrappedConfig,
      })
    }),
    Stream.changes
  )

export { watchSnapshots }
export type { WatchSnapshotsOpts, ShallowConfig, ShallowPrimitive }
