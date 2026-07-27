import { Arbitrary, DateTime, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { SearchParams, type SearchParamsType } from './search-params.ts'

describe('DocumentReferenceSearchParams', () => {
  it('should decode every declared parameter from a wire query', () => {
    // Arrange
    const query = {
      _count: '20',
      _pageToken: 'opaque-server-token',
      _id: 'docref-42',
      identifier: 'urn:wildflower:web-trace|session-42',
      category: 'http://terminology.hl7.org/CodeSystem/document-category|clinical-note',
      type: 'http://loinc.org|18842-5',
      status: 'current',
      date: '2026-07-27T14:27:30.000Z',
    }

    // Act
    const decoded = decodeQuery(query)

    // Assert
    expect(decoded).toSchemaEqual(SearchParams, {
      _count: 20,
      _pageToken: 'opaque-server-token',
      _id: 'docref-42',
      identifier: 'urn:wildflower:web-trace|session-42',
      category: 'http://terminology.hl7.org/CodeSystem/document-category|clinical-note',
      type: 'http://loinc.org|18842-5',
      status: 'current',
      date: DateTime.unsafeMake('2026-07-27T14:27:30.000Z'),
    })
  })

  it.each([
    { param: '_id', wire: 'docref-42' },
    { param: 'identifier', wire: 'urn:wildflower:web-trace|session-42' },
    {
      param: 'category',
      wire: 'http://terminology.hl7.org/CodeSystem/document-category|clinical-note',
    },
    { param: 'type', wire: 'http://loinc.org|18842-5' },
    { param: 'status', wire: 'current' },
    { param: 'date', wire: '2026-07-27T14:27:30.000Z' },
  ])('should carry "$param" through the wire unchanged', ({ param, wire }) => {
    // Arrange
    const query = { [param]: wire }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(decodeQuery(query))

    // Assert — an undeclared key would be dropped on decode and absent here.
    expect(reEncoded).toEqual(query)
  })

  it('should not accept an undeclared parameter, in the type or on the wire', () => {
    // Arrange — `author` is a real FHIR R4 DocumentReference search parameter
    // this client deliberately does not declare. The `@ts-expect-error` IS the
    // assertion: it fails the typecheck if `author` ever becomes assignable.
    // @ts-expect-error — `author` is not a declared search parameter
    const undeclared: SearchParamsType = { author: 'Practitioner/1' }

    // Act — encode is the direction that reaches HFS (the client is the only
    // side that builds a query here); decode is the inbound direction.
    const encoded = Schema.encodeSync(SearchParams)(undeclared)
    const decoded = decodeQuery({ author: 'Practitioner/1' })

    // Assert — an undeclared key never reaches the server, and never comes back
    // through as a decoded field either.
    expect(encoded).toEqual({})
    expect(decoded).toEqual({})
  })

  it.each([
    { reason: 'a status outside the DocumentReference value set', query: { status: 'draft' } },
    { reason: 'a date that is not a parseable instant', query: { date: '2026-13-45' } },
    { reason: 'a _count above the 1000 page ceiling', query: { _count: '1001' } },
    { reason: 'a non-integer _count', query: { _count: '12.5' } },
  ])('should reject $reason', ({ query }) => {
    // Act
    const result = Schema.decodeUnknownEither(SearchParams)(query)

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })

  it('should normalize a partial-precision date to the instant it names', () => {
    // Arrange — FHIR reads `date=2026-07` as "anywhere in July 2026"; this
    // client has no range modelling, so the value collapses to one instant.
    const query = { date: '2026-07' }

    // Act
    const reEncoded = Schema.encodeSync(SearchParams)(decodeQuery(query))

    // Assert
    expect(reEncoded).toEqual({ date: '2026-07-01T00:00:00.000Z' })
  })

  it('should round-trip any parameter set through the wire', () => {
    fc.assert(
      fc.property(Arbitrary.make(SearchParams), (params) => {
        // Act
        const decoded = decodeQuery(Schema.encodeSync(SearchParams)(params))

        // Assert
        expect(decoded).toSchemaEqual(SearchParams, params)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should leave any canonical wire query unchanged by a round trip', () => {
    fc.assert(
      fc.property(canonicalWireQueryArb, (query) => {
        // Act
        const reEncoded = Schema.encodeSync(SearchParams)(decodeQuery(query))

        // Assert — no parameter is silently normalized on its way to HFS.
        expect(reEncoded).toEqual(query)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** Decodes a raw query-string record, as the server side of `setUrlParams` does. */
const decodeQuery = (query: Record<string, string | undefined>): SearchParamsType =>
  Schema.decodeUnknownSync(SearchParams)(query)

/**
 * Query records in the exact wire form each parameter encodes back to — the
 * canonical spellings a round trip must preserve character for character.
 */
const canonicalWireQueryArb: fc.Arbitrary<Record<string, string>> = fc.record(
  {
    _count: fc.integer({ min: 0, max: 1000 }).map(String),
    _pageToken: fc.string(),
    _id: fc.string(),
    identifier: fc.string(),
    category: fc.string(),
    type: fc.string(),
    status: fc.constantFrom('current', 'superseded', 'entered-in-error'),
    date: fc.date({ noInvalidDate: true }).map((instant) => instant.toISOString()),
  },
  { requiredKeys: [] }
)
