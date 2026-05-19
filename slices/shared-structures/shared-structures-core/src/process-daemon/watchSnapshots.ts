import type { Queryable } from '@livestore/livestore'
import { Data, Stream } from 'effect'

import type { ControlSnapshot } from './types.ts'

interface SubscribableStore {
  subscribeStream<T>(q: Queryable<T>): Stream.Stream<T>
}

interface WatchSnapshotsOpts<Raw, TConfig> {
  readonly store: SubscribableStore
  readonly query: Queryable<Raw>
  /**
   * Project the raw livestore row down to the daemon-relevant
   * `Snapshot`. `config` should be `null` when the row isn't ready to
   * drive a run (missing required fields, row absent, etc.) or a
   * `Data.struct` (or any value implementing `Equal.Equal`) so the
   * upstream `Stream.changes` deduplicator can compare structurally.
   *
   * The projection must include only user-controlled fields — anything
   * the daemon itself writes back (running/current* flags, error
   * messages, idle-port resets, etc.) must be excluded. Otherwise the
   * daemon's own commits change the projection and would re-enter the
   * pipeline, causing busy-retries on every error.
   */
  readonly readSnapshot: (raw: Raw) => ControlSnapshot<TConfig>
}

/**
 * Stage 1 of the process-daemon pipeline.
 *
 * Subscribe to a livestore singleton query, project each emit to a
 * `Snapshot<Config>` envelope, wrap the envelope in `Data.struct` so
 * `Stream.changes` can dedup via structural equality, and drop
 * consecutive duplicates.
 */
const watchSnapshots = <Raw, TConfig>(
  opts: WatchSnapshotsOpts<Raw, TConfig>
): Stream.Stream<ControlSnapshot<TConfig>> =>
  opts.store.subscribeStream(opts.query).pipe(
    Stream.map((raw) => Data.struct(opts.readSnapshot(raw))),
    Stream.changes
  )

export { watchSnapshots }
export type { WatchSnapshotsOpts }
