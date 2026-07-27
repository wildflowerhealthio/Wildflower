import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import type { TraceExchange } from 'web-trace-core'
import { arbitraries, traceExchange } from 'web-trace-core/test-helpers'

import {
  ANY,
  contentTypeOptions,
  filterExchanges,
  NO_FILTERS,
  normalizeContentType,
  STATUS_CLASSES,
  statusClassOf,
  type ExchangeFilters,
} from './filter-exchanges.ts'

describe('normalizeContentType', () => {
  it('should drop parameters and lower-case the media type', () => {
    // Act
    const normalized = normalizeContentType('Application/JSON; charset=utf-8')

    // Assert
    expect(normalized).toBe('application/json')
  })

  it('should always be idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (contentType) => {
        // Act
        const once = normalizeContentType(contentType)

        // Assert
        expect(normalizeContentType(once)).toBe(once)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should always collapse a media type and the same type with parameters onto one key', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('application/json', 'text/html', 'image/png'),
        fc.string({ minLength: 1 }).filter((parameter) => !parameter.includes(';')),
        (mediaType, parameter) => {
          // Act / Assert
          expect(normalizeContentType(`${mediaType};${parameter}`)).toBe(mediaType)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('statusClassOf', () => {
  it('should classify a status by its leading digit', () => {
    // Act / Assert
    expect(statusClassOf(200)).toBe('2xx')
    expect(statusClassOf(404)).toBe('4xx')
    expect(statusClassOf(503)).toBe('5xx')
  })

  it('should classify an opaque or aborted response as other rather than as a success', () => {
    // Arrange — the sniffer reports 0 for an opaque CORS response or an abort.

    // Act / Assert
    expect(statusClassOf(0)).toBe('other')
  })

  it('should always land a status in exactly one of the known classes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (status) => {
        // Act
        const statusClass = statusClassOf(status)

        // Assert
        expect(STATUS_CLASSES).toContain(statusClass)
        expect(statusClass === 'other').toBe(status < 100 || status >= 600)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('contentTypeOptions', () => {
  it('should offer each distinct content type once, alphabetically', () => {
    // Arrange
    const exchanges = [
      withContentType('text/html'),
      withContentType('application/json; charset=utf-8'),
      withContentType('APPLICATION/JSON'),
    ]

    // Act
    const options = contentTypeOptions(exchanges)

    // Assert
    expect(options).toEqual(['application/json', 'text/html'])
  })

  it('should offer no option for a body whose content type is blank', () => {
    // Arrange
    const exchanges = [withContentType(''), withContentType('application/json')]

    // Act
    const options = contentTypeOptions(exchanges)

    // Assert
    expect(options).toEqual(['application/json'])
  })

  it('should always offer options that select at least one exchange', () => {
    fc.assert(
      fc.property(corpus(), (exchanges) => {
        // Act
        const options = contentTypeOptions(exchanges)

        // Assert
        for (const contentType of options) {
          expect(filterExchanges(exchanges, { ...NO_FILTERS, contentType }).length).toBeGreaterThan(
            0
          )
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('filterExchanges', () => {
  it('should narrow to exchanges whose URL contains the query, case-insensitively', () => {
    // Arrange
    const exchanges = [
      traceExchange({ requestId: 'a', url: 'https://portal.example.org/api/v2/Patients/17' }),
      traceExchange({ requestId: 'b', url: 'https://portal.example.org/api/v2/observations' }),
    ]

    // Act
    const matching = filterExchanges(exchanges, { ...NO_FILTERS, urlQuery: 'patients' })

    // Assert
    expect(matching.map((exchange) => exchange.requestId)).toEqual(['a'])
  })

  it('should narrow to a response class', () => {
    // Arrange
    const exchanges = [
      traceExchange({ requestId: 'ok', status: 200 }),
      traceExchange({ requestId: 'missing', status: 404 }),
      traceExchange({ requestId: 'broken', status: 500 }),
    ]

    // Act
    const matching = filterExchanges(exchanges, { ...NO_FILTERS, statusClass: '4xx' })

    // Assert
    expect(matching.map((exchange) => exchange.requestId)).toEqual(['missing'])
  })

  it('should narrow to a content type regardless of its parameters', () => {
    // Arrange
    const exchanges = [
      { ...withContentType('application/json; charset=utf-8'), requestId: 'json' },
      { ...withContentType('text/html'), requestId: 'html' },
    ]

    // Act
    const matching = filterExchanges(exchanges, { ...NO_FILTERS, contentType: 'application/json' })

    // Assert
    expect(matching.map((exchange) => exchange.requestId)).toEqual(['json'])
  })

  it('should conjoin the three axes', () => {
    // Arrange
    const exchanges = [
      {
        ...withContentType('application/json'),
        requestId: 'wanted',
        status: 200,
        url: 'https://h/a',
      },
      {
        ...withContentType('application/json'),
        requestId: 'wrong-status',
        status: 404,
        url: 'https://h/a',
      },
      { ...withContentType('text/html'), requestId: 'wrong-type', status: 200, url: 'https://h/a' },
      {
        ...withContentType('application/json'),
        requestId: 'wrong-url',
        status: 200,
        url: 'https://h/b',
      },
    ]

    // Act
    const matching = filterExchanges(exchanges, {
      urlQuery: '/a',
      statusClass: '2xx',
      contentType: 'application/json',
    })

    // Assert
    expect(matching.map((exchange) => exchange.requestId)).toEqual(['wanted'])
  })

  it('should always be the identity under the resting filters', () => {
    fc.assert(
      fc.property(corpus(), (exchanges) => {
        // Act / Assert — each axis has to be neutral at its resting value
        expect(filterExchanges(exchanges, NO_FILTERS)).toEqual(exchanges)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never reorder or invent rows', () => {
    fc.assert(
      fc.property(corpus(), filters(), (exchanges, active) => {
        // Act
        const matching = filterExchanges(exchanges, active)

        // Assert — the result is a subsequence of the input
        expect(matching.every((exchange) => exchanges.includes(exchange))).toBe(true)
        expect(matching).toEqual(exchanges.filter((exchange) => matching.includes(exchange)))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never keep a row that fails an active axis', () => {
    fc.assert(
      fc.property(corpus(), filters(), (exchanges, active) => {
        // Act
        const matching = filterExchanges(exchanges, active)

        // Assert
        const needle = active.urlQuery.trim().toLowerCase()
        for (const exchange of matching) {
          if (needle !== '') expect(exchange.url.toLowerCase()).toContain(needle)
          if (active.statusClass !== ANY) {
            expect(statusClassOf(exchange.status)).toBe(active.statusClass)
          }
          if (active.contentType !== ANY) {
            expect(normalizeContentType(exchange.body.contentType)).toBe(active.contentType)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never drop a row that passes every active axis', () => {
    fc.assert(
      fc.property(corpus(), filters(), (exchanges, active) => {
        // Act
        const matching = filterExchanges(exchanges, active)

        // Assert — the complement carries no false negatives
        const needle = active.urlQuery.trim().toLowerCase()
        for (const exchange of exchanges) {
          const passes =
            (needle === '' || exchange.url.toLowerCase().includes(needle)) &&
            (active.statusClass === ANY || statusClassOf(exchange.status) === active.statusClass) &&
            (active.contentType === ANY ||
              normalizeContentType(exchange.body.contentType) === active.contentType)
          expect(matching.includes(exchange)).toBe(passes)
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

const withContentType = (contentType: string): TraceExchange =>
  traceExchange({
    body: {
      _tag: 'StoredBody',
      contentType,
      data: '',
      size: 0,
      hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
    },
  })

const corpus = (): fc.Arbitrary<readonly TraceExchange[]> =>
  fc
    .array(arbitraries(fc).exchange)
    .map((exchanges) => exchanges.map((one, index) => ({ ...one, requestId: `r${index}` })))

/** Filter sets that reach every combination of resting and active axes. */
const filters = (): fc.Arbitrary<ExchangeFilters> =>
  fc.record({
    urlQuery: fc.constantFrom('', 'patients', '/api/', 'EXAMPLE', 'nothing-matches-this'),
    statusClass: fc.constantFrom(ANY, ...STATUS_CLASSES),
    contentType: fc.constantFrom(ANY, 'application/json', 'text/html', 'application/pdf'),
  })
