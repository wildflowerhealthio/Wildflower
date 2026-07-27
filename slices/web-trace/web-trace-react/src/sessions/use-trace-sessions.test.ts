import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { TraceExchange } from 'web-trace-core'
import { arbitraries, traceExchange } from 'web-trace-core/test-helpers'

import type { TraceExchangePage } from '../queries/index.ts'
import { summarizePages } from './use-trace-sessions.ts'

describe('summarizePages', () => {
  it('should summarise no pages as no sessions', () => {
    // Act
    const summary = summarizePages([])

    // Assert
    expect(summary).toEqual({ sessions: [], unreadableCount: 0 })
  })

  it('should group a session whose exchanges straddle a page boundary into one row', () => {
    // Arrange
    const pages = [
      page([traceExchange({ sessionId: 'morning', requestId: 'a', startedAtMillis: 1_000 })]),
      page([traceExchange({ sessionId: 'morning', requestId: 'b', startedAtMillis: 2_000 })]),
    ]

    // Act
    const summary = summarizePages(pages)

    // Assert — grouping per page would list "morning" twice
    expect(summary.sessions).toHaveLength(1)
    expect(summary.sessions[0]?.exchanges.map((exchange) => exchange.requestId)).toEqual(['a', 'b'])
  })

  it('should always account for every exchange across every page', () => {
    fc.assert(
      fc.property(pages(), (fetched) => {
        // Act
        const summary = summarizePages(fetched)

        // Assert
        const grouped = summary.sessions.flatMap((session) => session.exchanges)
        expect(grouped).toHaveLength(fetched.flatMap((one) => one.exchanges).length)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always report the running total of what could not be read', () => {
    fc.assert(
      fc.property(pages(), (fetched) => {
        // Act
        const summary = summarizePages(fetched)

        // Assert
        expect(summary.unreadableCount).toBe(
          fetched.reduce((total, one) => total + one.unreadable, 0)
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const page = (exchanges: readonly TraceExchange[], unreadable = 0): TraceExchangePage => ({
  exchanges,
  unreadable,
  nextPageToken: undefined,
})

const pages = (): fc.Arbitrary<readonly TraceExchangePage[]> =>
  fc
    .array(
      fc.tuple(
        fc.array(fc.tuple(arbitraries(fc).exchange, fc.constantFrom('session-a', 'session-b'))),
        fc.nat({ max: 5 })
      )
    )
    .map((drawn) =>
      drawn.map(([exchanges, unreadable], pageIndex) =>
        page(
          exchanges.map(([exchange, sessionId], index) => ({
            ...exchange,
            sessionId,
            requestId: `p${pageIndex}-r${index}`,
          })),
          unreadable
        )
      )
    )
