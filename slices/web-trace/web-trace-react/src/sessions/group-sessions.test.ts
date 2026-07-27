import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { TraceExchange } from 'web-trace-core'
import { arbitraries, traceExchange } from 'web-trace-core/test-helpers'

import { groupIntoSessions, hostOf } from './group-sessions.ts'

describe('hostOf', () => {
  it('should return the host of a URL', () => {
    // Act
    const host = hostOf('https://portal.example.org/api/v2/patients?q=1')

    // Assert
    expect(host).toBe('portal.example.org')
  })

  it('should keep the port, which distinguishes two servers on one hostname', () => {
    // Act
    const host = hostOf('https://portal.example.org:8443/api/v2/patients')

    // Assert
    expect(host).toBe('portal.example.org:8443')
  })

  it('should fall back to the raw value when the URL does not parse', () => {
    // Act
    const host = hostOf('not a url at all')

    // Assert
    expect(host).toBe('not a url at all')
  })

  it('should fall back to the raw value for a URL that parses but names no host', () => {
    // Arrange — `blob:` and `data:` parse, and their `host` is the empty string.

    // Act / Assert — a blank would describe the session with nothing at all
    expect(hostOf('blob:https://portal.example.org/2f8c-4a1b')).toBe(
      'blob:https://portal.example.org/2f8c-4a1b'
    )
    expect(hostOf('data:text/html,hello')).toBe('data:text/html,hello')
  })

  it('should never describe a non-empty URL with a blank host', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (url) => {
        // Act / Assert — the result is either a real host or the URL itself
        expect(hostOf(url)).not.toBe('')
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('groupIntoSessions', () => {
  it('should return no sessions for no exchanges', () => {
    // Act
    const sessions = groupIntoSessions([])

    // Assert
    expect(sessions).toEqual([])
  })

  it('should group exchanges under the session id they were captured with', () => {
    // Arrange
    const exchanges = [
      traceExchange({ sessionId: 'morning', requestId: 'a', startedAtMillis: 1_000 }),
      traceExchange({ sessionId: 'evening', requestId: 'b', startedAtMillis: 5_000 }),
      traceExchange({ sessionId: 'morning', requestId: 'c', startedAtMillis: 2_000 }),
    ]

    // Act
    const sessions = groupIntoSessions(exchanges)

    // Assert — most recently active first
    expect(sessions.map((session) => session.sessionId)).toEqual(['evening', 'morning'])
    expect(sessions[1]?.exchanges.map((exchange) => exchange.requestId)).toEqual(['a', 'c'])
  })

  it('should list the distinct hosts a session talked to, in first-seen order', () => {
    // Arrange
    const exchanges = [
      traceExchange({ requestId: 'a', url: 'https://portal.example.org/one', startedAtMillis: 1 }),
      traceExchange({ requestId: 'b', url: 'https://api.example.com/two', startedAtMillis: 2 }),
      traceExchange({
        requestId: 'c',
        url: 'https://portal.example.org/three',
        startedAtMillis: 3,
      }),
    ]

    // Act
    const [session] = groupIntoSessions(exchanges)

    // Assert
    expect(session?.hosts).toEqual(['portal.example.org', 'api.example.com'])
  })

  it('should report the session window as the first and last response start', () => {
    // Arrange
    const exchanges = [
      traceExchange({ requestId: 'b', startedAtMillis: 9_000 }),
      traceExchange({ requestId: 'a', startedAtMillis: 3_000 }),
    ]

    // Act
    const [session] = groupIntoSessions(exchanges)

    // Assert
    expect(millisOf(session?.firstActivityAt)).toBe(3_000)
    expect(millisOf(session?.lastActivityAt)).toBe(9_000)
  })

  it('should never lose or duplicate an exchange', () => {
    fc.assert(
      fc.property(corpus(), (exchanges) => {
        // Act
        const sessions = groupIntoSessions(exchanges)

        // Assert — the grouping is a partition, not a filter
        const regrouped = sessions.flatMap((session) => session.exchanges)
        expect(sortedIds(regrouped)).toEqual(sortedIds(exchanges))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always put an exchange under its own session id, exactly once', () => {
    fc.assert(
      fc.property(corpus(), (exchanges) => {
        // Act
        const sessions = groupIntoSessions(exchanges)

        // Assert
        const ids = sessions.map((session) => session.sessionId)
        expect(new Set(ids).size).toBe(ids.length)
        expect(new Set(ids)).toEqual(new Set(exchanges.map((exchange) => exchange.sessionId)))
        for (const session of sessions) {
          for (const exchange of session.exchanges) {
            expect(exchange.sessionId).toBe(session.sessionId)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always order exchanges oldest first and sessions most-recent first', () => {
    fc.assert(
      fc.property(corpus(), (exchanges) => {
        // Act
        const sessions = groupIntoSessions(exchanges)

        // Assert
        for (const session of sessions) {
          const starts = session.exchanges.map((exchange) => millisOf(exchange.startedAt))
          expect(starts).toEqual([...starts].toSorted((left, right) => left - right))
          expect(millisOf(session.firstActivityAt)).toBe(Math.min(...starts))
          expect(millisOf(session.lastActivityAt)).toBe(Math.max(...starts))
        }
        const lastActivity = sessions.map((session) => millisOf(session.lastActivityAt))
        expect(lastActivity).toEqual([...lastActivity].toSorted((left, right) => right - left))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always produce the same grouping whatever order the pages arrived in', () => {
    fc.assert(
      fc.property(
        corpus().chain((exchanges) =>
          fc.tuple(
            fc.constant(exchanges),
            fc.shuffledSubarray([...exchanges], {
              minLength: exchanges.length,
              maxLength: exchanges.length,
            })
          )
        ),
        ([exchanges, shuffled]) => {
          // Act
          const fromOriginal = groupIntoSessions(exchanges)
          const fromShuffled = groupIntoSessions(shuffled)

          // Assert — the orderings are total, so paging order cannot reorder rows
          expect(fromShuffled).toEqual(fromOriginal)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always describe a session with hosts drawn only from its own exchanges', () => {
    fc.assert(
      fc.property(corpus(), (exchanges) => {
        // Act
        const sessions = groupIntoSessions(exchanges)

        // Assert
        for (const session of sessions) {
          const observed = session.exchanges.map((exchange) => hostOf(exchange.url))
          expect(new Set(session.hosts).size).toBe(session.hosts.length)
          expect(session.hosts).toEqual([...new Set(observed)])
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/**
 * Exchanges spread across several sessions, with ids unique within each session
 * — the invariant the codec's `{sessionId}-{requestId}` resource id relies on,
 * and the one that makes "never lose or duplicate" a meaningful property.
 */
const corpus = (): fc.Arbitrary<readonly TraceExchange[]> =>
  fc
    .array(
      fc.tuple(arbitraries(fc).exchange, fc.constantFrom('session-a', 'session-b', 'session-c'))
    )
    .map((drawn) =>
      drawn.map(([exchange, sessionId], index) => ({
        ...exchange,
        sessionId,
        requestId: `r${index}`,
      }))
    )

const millisOf = (moment: DateTime.Utc | undefined): number =>
  moment === undefined ? Number.NaN : DateTime.toEpochMillis(moment)

const sortedIds = (exchanges: readonly TraceExchange[]): readonly string[] =>
  exchanges.map((exchange) => `${exchange.sessionId}-${exchange.requestId}`).toSorted()
