import { DateTime } from 'effect'
import type { TraceExchange } from 'web-trace-core'

/**
 * Turning a flat page of exchanges into the sessions the recordings tab lists.
 *
 * @remarks
 * A session is not a resource. Every exchange carries the session id it was
 * captured under as a shared `identifier` value, and nothing joins them — so
 * "the sessions on this device" is a grouping of whatever exchanges have been
 * read, not a table that can be queried. That is why this is a pure function
 * over the pages the query has delivered, and why a session's counts are
 * complete only once paging is.
 */

/** One recording session, derived from the exchanges captured under its id. */
interface TraceSession {
  /** The shared `identifier` value every exchange in the session carries. */
  readonly sessionId: string
  /** The session's exchanges, oldest first. */
  readonly exchanges: readonly TraceExchange[]
  /** Response start of the earliest exchange in {@link TraceSession.exchanges}. */
  readonly firstActivityAt: DateTime.Utc
  /** Response start of the latest exchange in {@link TraceSession.exchanges}. */
  readonly lastActivityAt: DateTime.Utc
  /**
   * The distinct hosts the session talked to, in first-seen order.
   *
   * @remarks
   * A session id says nothing about what was recorded; the hosts are what let a
   * reviewer recognise which portal a row is. A URL that does not parse
   * contributes itself, so an unusual capture is still listed rather than
   * silently dropped from its own session's description.
   */
  readonly hosts: readonly string[]
}

/**
 * The host an exchange addressed, falling back to the raw URL.
 *
 * @param url - The exchange's URL as the sniffer reported it
 * @returns The URL's host, or the URL itself when it does not parse or names no
 *   host
 *
 * @remarks
 * The sniffer types `url` as a plain string, so a value `URL` rejects is
 * possible; the raw string never claims a host that was not observed. A URL that
 * parses but carries no authority — `blob:`, `data:`, `about:` — has an empty
 * `host`, which would describe the session with a blank, so it falls back the
 * same way an unparseable value does.
 */
const hostOf = (url: string): string => {
  try {
    const { host } = new URL(url)
    return host === '' ? url : host
  } catch {
    return url
  }
}

/** Ordering within a session: oldest first, ties broken by request id so the order is total. */
const byStartedAtThenRequestId = (left: TraceExchange, right: TraceExchange): number => {
  const difference =
    DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt)
  return difference !== 0 ? difference : left.requestId.localeCompare(right.requestId)
}

/** Ordering between sessions: most recently active first, ties broken by id so the order is total. */
const byLastActivityDescending = (left: TraceSession, right: TraceSession): number => {
  const difference =
    DateTime.toEpochMillis(right.lastActivityAt) - DateTime.toEpochMillis(left.lastActivityAt)
  return difference !== 0 ? difference : left.sessionId.localeCompare(right.sessionId)
}

/**
 * Groups exchanges into sessions by their shared session id.
 *
 * @param exchanges - Every exchange read so far, in any order
 * @returns The sessions, most recently active first, each holding its own
 *   exchanges oldest first
 *
 * @remarks
 * Both orderings fall back to an id comparison, making them total: two exchanges
 * recorded in the same millisecond do not reorder between renders, and neither
 * does a session whose exchanges arrive across two pages.
 */
const groupIntoSessions = (exchanges: readonly TraceExchange[]): readonly TraceSession[] => {
  const bySession = new Map<string, TraceExchange[]>()
  for (const exchange of exchanges) {
    const existing = bySession.get(exchange.sessionId)
    if (existing === undefined) bySession.set(exchange.sessionId, [exchange])
    else existing.push(exchange)
  }

  return [...bySession]
    .map(([sessionId, members]): TraceSession => {
      const ordered = [...members].toSorted(byStartedAtThenRequestId)
      const first = ordered[0]
      const last = ordered[ordered.length - 1]
      // `ordered` is non-empty by construction — a key exists only because an
      // exchange was pushed under it — but the index reads are still narrowed
      // rather than asserted.
      const firstActivityAt = first === undefined ? DateTime.unsafeMake(0) : first.startedAt
      const lastActivityAt = last === undefined ? firstActivityAt : last.startedAt
      return {
        sessionId,
        exchanges: ordered,
        firstActivityAt,
        lastActivityAt,
        hosts: [...new Set(ordered.map((exchange) => hostOf(exchange.url)))],
      }
    })
    .toSorted(byLastActivityDescending)
}

export { groupIntoSessions, hostOf, type TraceSession }
