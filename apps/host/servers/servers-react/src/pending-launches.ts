import type { DateTime } from 'effect'
import { Option } from 'effect'
import { useSyncExternalStore } from 'react'

/** A start-and-launch waiting for the started server to become launchable. */
interface WaitingLaunch {
  readonly kind: 'waiting'
  /**
   * When "Start and launch" was confirmed, by this device's clock, which
   * also stamps the host's stops: a stop after it is one during the wait.
   */
  readonly confirmedAt: DateTime.Utc
  /**
   * Since when, by this device's clock, the server has been unreachable
   * through its relay while its certificate is valid, without a break; none
   * while it isn't.
   */
  readonly unreachableSince: Option.Option<DateTime.Utc>
}

/**
 * A server's start-and-launch, from the confirmed "Start and launch" until it
 * launches or gives up: waiting for the started server to become launchable,
 * launching it, or the failure that ended it.
 */
type PendingLaunch =
  | WaitingLaunch
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
const makeEmptyPendingLaunches = (): PendingLaunches => {
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

export { makeEmptyPendingLaunches, usePendingLaunch }
export type { PendingLaunch, PendingLaunches, WaitingLaunch }
