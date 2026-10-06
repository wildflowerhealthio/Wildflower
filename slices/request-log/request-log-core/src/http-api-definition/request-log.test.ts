import { Arbitrary, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  CallerSummarySchema,
  ListRequestsUrlParamsSchema,
  RequestLogPageSchema,
} from './request-log.ts'

const { expectLeftToEqual } = utilityExpectations(expect)

describe('CallerSummarySchema', () => {
  it('round-trips any schema-conformant caller summary', () => {
    fc.assert(
      fc.property(Arbitrary.make(CallerSummarySchema), (summary) => {
        const encoded = Schema.encodeSync(CallerSummarySchema)(summary)
        expect(Schema.decodeSync(CallerSummarySchema)(encoded)).toEqual(summary)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('decodes the unverified-caller row the server sends, its nulls as None', () => {
    const wire = {
      clientId: null,
      address: '203.0.113.9',
      firstSeen: '2026-07-01T12:00:20.000Z',
      lastSeen: '2026-07-01T12:00:50.000Z',
      requestCount: 2,
      refusedCount: 2,
      lastStatus: 401,
      lastRefusal: 'revoked',
    }
    const decoded = Schema.decodeUnknownSync(CallerSummarySchema)(wire)
    expect(decoded.clientId).toEqual(Option.none())
    expect(decoded.address).toEqual(Option.some('203.0.113.9'))
    expect(decoded.lastRefusal).toEqual(Option.some('revoked'))
    expect(Schema.encodeSync(CallerSummarySchema)(decoded)).toEqual(wire)
  })
})

describe('RequestLogPageSchema', () => {
  it('round-trips any schema-conformant page', () => {
    fc.assert(
      fc.property(Arbitrary.make(RequestLogPageSchema), (page) => {
        const encoded = Schema.encodeSync(RequestLogPageSchema)(page)
        expect(Schema.decodeSync(RequestLogPageSchema)(encoded)).toEqual(page)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('decodes the last page, with no cursor and an unknown response size', () => {
    const decoded = Schema.decodeUnknownSync(RequestLogPageSchema)({
      requests: [
        {
          id: 1,
          receivedAt: '2026-07-01T12:00:00.123Z',
          clientId: 'lifting',
          address: '192.0.2.1',
          servedHost: 'dev1.example.com',
          method: 'GET',
          path: '/fhir-r4/Patient',
          status: 200,
          responseBytes: null,
          durationMs: 12,
          refusal: null,
        },
      ],
      nextCursor: null,
    })
    expect(decoded.nextCursor).toEqual(Option.none())
    expect(decoded.requests[0]?.responseBytes).toEqual(Option.none())
    expect(decoded.requests[0]?.servedHost).toEqual(Option.some('dev1.example.com'))
  })
})

describe('ListRequestsUrlParamsSchema', () => {
  it('encodes the cursor and auth filter as query text', () => {
    expect(
      Schema.encodeSync(ListRequestsUrlParamsSchema)({
        cursor: 6,
        auth: 'refused',
        client: 'lifting',
      })
    ).toEqual({ cursor: '6', auth: 'refused', client: 'lifting' })
  })

  it('rejects an auth case it does not know', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(ListRequestsUrlParamsSchema)({ auth: 'verified' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects a cursor that is not a whole number', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(ListRequestsUrlParamsSchema)({ cursor: '6.5' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })
})
