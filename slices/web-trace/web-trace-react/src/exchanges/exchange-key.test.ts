import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { traceResourceId } from 'web-trace-core'
import { traceExchange } from 'web-trace-core/test-helpers'

import { exchangeKey } from './exchange-key.ts'

/**
 * A generator that can emit the separator a naive join would use.
 *
 * @remarks
 * `fc.string()` reaches the `('s-req', '77')` / `('s', 'req-77')` shape only by
 * accident and effectively never, so a distinctness property written over it
 * would pass without ever exercising the case it exists for.
 */
const hyphenProne = fc
  .array(fc.constantFrom('s', '-', ':', '0', '1', 'req'), { minLength: 1, maxLength: 6 })
  .map((parts) => parts.join(''))

describe('exchangeKey', () => {
  it('should key an exchange by its (sessionId, requestId) pair alone', () => {
    // Arrange — same pair, everything else different
    const first = traceExchange({ sessionId: 'run-1', requestId: 'req-7' })
    const second = traceExchange({
      sessionId: 'run-1',
      requestId: 'req-7',
      url: 'https://elsewhere.example/other',
      status: 500,
      startedAtMillis: 1,
    })

    // Assert
    expect(exchangeKey(first)).toBe(exchangeKey(second))
  })

  it('should distinguish exchanges whose pairs differ', () => {
    fc.assert(
      fc.property(
        fc.tuple(hyphenProne, hyphenProne),
        fc.tuple(hyphenProne, hyphenProne),
        ([sessionA, requestA], [sessionB, requestB]) => {
          // Arrange
          fc.pre(sessionA !== sessionB || requestA !== requestB)

          // Act
          const left = exchangeKey({ sessionId: sessionA, requestId: requestA })
          const right = exchangeKey({ sessionId: sessionB, requestId: requestB })

          // Assert
          expect(left).not.toBe(right)
        }
      ),
      { numRuns: numRunsFor({ base: 500 }) }
    )
  })

  // The specific shape a `${sessionId}-${requestId}` key collapses, which would
  // open the wrong row from the exchange list.
  it('should not let the session id absorb part of the request id', () => {
    // Assert
    expect(exchangeKey({ sessionId: 's-req', requestId: '77' })).not.toBe(
      exchangeKey({ sessionId: 's', requestId: 'req-77' })
    )
  })

  // This is the point of the module existing: the render paths must not be
  // paying for the derivation the codec pays for. If someone "unifies" the two,
  // this fails and sends them to the doc comment.
  it('should not be the FHIR resource id', () => {
    // Arrange
    const exchange = traceExchange({ sessionId: 'run-1', requestId: 'req-7' })

    // Assert
    expect(exchangeKey(exchange)).not.toBe(traceResourceId(exchange))
    expect(exchangeKey(exchange)).toContain('run-1')
  })
})
