import { Option, Stream } from 'effect'

import type { Intent, ControlSnapshot } from './types.ts'

const transitionIntent = <Config>(
  prev: ControlSnapshot<Config> | null,
  curr: ControlSnapshot<Config>
): Option.Option<Intent<Config>> => {
  const wasActive = prev !== null && prev.requestedRunning && prev.config !== null
  const isActive = curr.requestedRunning && curr.config !== null
  if (isActive) {
    // Upstream `Stream.changes` already filtered the "same active
    // config" case (both `requestedRunning` and `config` unchanged), so
    // any active snapshot reaching this stage is a transition: either
    // a fresh start (wasActive false) or a reconfigure (config differs
    // from prev).
    return Option.some({ _tag: 'StartOrReconfigure', config: curr.config as Config })
  }
  if (wasActive) return Option.some({ _tag: 'Stop' })
  // Initial inactive snapshot (daemon just subscribed, row is "not
  // requested") — nothing to do.
  return Option.none()
}

/**
 * Stage 2 of the process-daemon pipeline.
 *
 * Fold consecutive snapshots into transition intents. Filters out the
 * "no transition" case (initial inactive snapshot, or pairs where
 * neither side is active) — every other `Snapshot` reaching this stage
 * has already passed `Stream.changes` and represents a meaningful
 * transition.
 *
 * The Failed-state busy-retry guard from the old `computeIntent` is not
 * needed here: the daemon's own error commits don't change the snapshot
 * projection (Stage 1 projects only `{requestedRunning, config}`), so
 * they're dedupped upstream rather than producing a spurious retry.
 */
const diffIntents = <Config>(
  snapshots: Stream.Stream<ControlSnapshot<Config>>
): Stream.Stream<Intent<Config>> =>
  snapshots.pipe(
    Stream.mapAccum<
      ControlSnapshot<Config> | null,
      ControlSnapshot<Config>,
      Option.Option<Intent<Config>>
    >(null, (prev, curr) => [curr, transitionIntent(prev, curr)]),
    Stream.filterMap((i) => i)
  )

export { diffIntents }
