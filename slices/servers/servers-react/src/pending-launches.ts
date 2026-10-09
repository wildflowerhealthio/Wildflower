import type { DateTime } from 'effect'
import { Option } from 'effect'
import { useSyncExternalStore } from 'react'

/**
 * A server's start-and-launch, from the confirmed "Start and launch" until it
 * launches or gives up: waiting for the started server to become launchable,
 * launching it, or the failure that ended it.
 */
type PendingLaunch =
  | {
      readonly kind: 'waiting'
      /**
       * When the server's latest run stopped, as its status said when the
       * wait began, if it had run: a stop the wait sees at any other time is
       * one since the start.
       */
      readonly stoppedBeforeStart: Option.Option<DateTime.Utc>
    }
  | { readonly kind: 'launching' }
  | { readonly kind: 'failed'; readonly failure: string }

/**
 * The servers' pending start-and-launches, by domain: one store for the base,
 * in the router context, so a wait outlives the Launch that began it, as when
 * Edit opens the server's page, whose Launch shows the same wait.
 */
interface PendingLaunches {
  /** The server `domain`'s pending launch, or `undefined`. */
  readonly snapshotOf: (domain: string) => PendingLaunch | undefined
  /** Set the server `domain`'s pending launch, or clear it with none. */
  readonly set: (domain: string, launch: Option.Option<PendingLaunch>) => void
  /** Call `onChange` after every `set`, until unsubscribed. */
  readonly subscribe: (onChange: () => void) => () => void
}

/** A store holding no pending launch. */
const makePendingLaunches = (): PendingLaunches => {
  const launches = new Map<string, PendingLaunch>()
  const listeners = new Set<() => void>()
  return {
    snapshotOf: (domain) => launches.get(domain),
    set: (domain, launch) => {
      Option.match(launch, {
        onNone: () => launches.delete(domain),
        onSome: (pending) => launches.set(domain, pending),
      })
      for (const listener of listeners) listener()
    },
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

/** The server `domain`'s pending launch in `pendingLaunches`, kept current. */
const usePendingLaunch = (
  pendingLaunches: PendingLaunches,
  domain: string
): Option.Option<PendingLaunch> =>
  Option.fromNullable(
    useSyncExternalStore(pendingLaunches.subscribe, () => pendingLaunches.snapshotOf(domain))
  )

export { makePendingLaunches, usePendingLaunch }
export type { PendingLaunch, PendingLaunches }
