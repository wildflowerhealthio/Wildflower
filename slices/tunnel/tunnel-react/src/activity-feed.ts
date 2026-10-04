import { DateTime, Duration, Option } from 'effect'

import type { ActivityEntry } from './components/TunnelActivityFeed.tsx'
import type { CallerSummary, LoggedRequest } from './queries/index.ts'
import { callerNameOf, requestAccessOf } from './request-log.ts'

/** How many requests the log holds in each `auth` case. */
interface ActivityCounts {
  readonly authorized: number
  readonly public: number
  readonly refused: number
}

/** What a feed row shows for a caller whose address wasn't recorded. */
const UNKNOWN_ADDRESS = 'Unknown address'

/**
 * One `ListCallers` row as a feed entry: who (see `callerNameOf`), from where,
 * when last, and how its last request met the bearer gates.
 */
const activityEntryOf = (
  caller: CallerSummary,
  names: ReadonlyMap<string, string>
): ActivityEntry => ({
  name: callerNameOf(caller.clientId, names),
  location: Option.getOrElse(caller.address, () => UNKNOWN_ADDRESS),
  lastConnectionAt: caller.lastSeen,
  access: requestAccessOf({
    clientId: caller.clientId,
    status: caller.lastStatus,
    refusal: caller.lastRefusal,
  }),
})

/**
 * Count the log's requests by `auth` case. A caller's refused requests are its
 * `refusedCount`; the rest were signed in when it has a `clientId` and needed
 * no sign-in when it hasn't.
 */
const activityCountsOf = (callers: readonly CallerSummary[]): ActivityCounts =>
  callers.reduce<ActivityCounts>(
    (counts, caller) => {
      const admitted = caller.requestCount - caller.refusedCount
      const verified = Option.isSome(caller.clientId)
      return {
        authorized: counts.authorized + (verified ? admitted : 0),
        public: counts.public + (verified ? 0 : admitted),
        refused: counts.refused + caller.refusedCount,
      }
    },
    { authorized: 0, public: 0, refused: 0 }
  )

/** How many refused requests from one address make a streak worth a warning. */
const REFUSED_STREAK_THRESHOLD = 10

/** The window a streak's refused requests fall in, ending now. */
const REFUSED_STREAK_WINDOW = Duration.minutes(10)

/** An address that has been refused at least {@link REFUSED_STREAK_THRESHOLD} times lately. */
interface RefusedStreak {
  readonly address: string
  readonly count: number
}

/**
 * The addresses with {@link REFUSED_STREAK_THRESHOLD} or more refused requests
 * in the {@link REFUSED_STREAK_WINDOW} up to `now` — a sign of credential
 * guessing — most refused first. Requests outside the window, not refused, or
 * with no address are ignored, so any slice of the log can be passed in.
 */
const refusedStreaksOf = (
  requests: readonly LoggedRequest[],
  now: DateTime.DateTime
): readonly RefusedStreak[] => {
  const since = DateTime.subtractDuration(now, REFUSED_STREAK_WINDOW)
  const counts = requests.reduce(
    (byAddress, request) =>
      request.address.pipe(
        Option.filter(
          () =>
            requestAccessOf(request).auth === 'refused' &&
            !DateTime.lessThan(request.receivedAt, since)
        ),
        Option.match({
          onNone: () => byAddress,
          onSome: (address) => byAddress.set(address, (byAddress.get(address) ?? 0) + 1),
        })
      ),
    new Map<string, number>()
  )
  return [...counts]
    .filter(([, count]) => count >= REFUSED_STREAK_THRESHOLD)
    .map(([address, count]) => ({ address, count }))
    .toSorted((a, b) => b.count - a.count)
}

export {
  activityCountsOf,
  activityEntryOf,
  REFUSED_STREAK_THRESHOLD,
  REFUSED_STREAK_WINDOW,
  refusedStreaksOf,
  UNKNOWN_ADDRESS,
}
export type { ActivityCounts, RefusedStreak }
