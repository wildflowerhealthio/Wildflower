import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Array, Effect, Layer, Record, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { IdentifierAndReference } from '../data-types/index.ts'
import {
  FhirR4ResourcesHttpApiClient,
  searchAllOfType,
  type SearchableResourceType,
  searchByIdentifiers,
} from './index.ts'
import { IDENTIFIER_CHUNK_SIZE } from './search-by-type.ts'

describe('searchByIdentifiers', () => {
  it('should send one POST <Type>/_search with the identifiers as one escaped token value and a full page', async () => {
    // Arrange
    const identifiers = Array.make(
      qualified('https://shoppers.example/customer', '123'),
      qualified('https://rexall.example/uid', 'a,b|c')
    )

    // Act
    const { requests } = await runWith(searchByIdentifiers('Patient', identifiers), () =>
      searchset([storedPatient('p-1')], null)
    )

    // Assert
    expect(requests).toEqual([
      {
        method: 'POST',
        url: `${TEST_ORIGIN}/Patient/_search`,
        form: {
          identifier: 'https://shoppers.example/customer|123,https://rexall.example/uid|a\\,b\\|c',
          _count: '1000',
        },
      },
    ])
  })

  it('should search the identifiers a chunk at a time, giving a resource two chunks match once', async () => {
    // Arrange: one identifier more than a chunk holds
    const identifiers = Array.makeBy(IDENTIFIER_CHUNK_SIZE + 1, (index) =>
      qualified('https://shoppers.example/customer', `${index}`)
    )
    const lastIdentifier = `https://shoppers.example/customer|${IDENTIFIER_CHUNK_SIZE}`

    // Act
    const { requests, result } = await runWith(
      searchByIdentifiers('Patient', identifiers),
      (form) =>
        form['identifier'] === lastIdentifier
          ? searchset([storedPatient('p-both'), storedPatient('p-2')], null)
          : searchset([storedPatient('p-1'), storedPatient('p-both')], null)
    )

    // Assert
    expect(requests.map(({ form }) => form['identifier']?.split(',').length)).toEqual([
      IDENTIFIER_CHUNK_SIZE,
      1,
    ])
    expect(result.map(({ id }) => id)).toEqual(['p-1', 'p-both', 'p-2'])
  })

  it('should follow next links to the last page, asking for each with the same identifiers', async () => {
    // Arrange
    const identifiers = Array.make(qualified('https://cpso.example/licence', 'A1234'))
    const pages = new Map([
      [undefined, searchset([storedPractitioner('d-1')], 'page-2')],
      ['page-2', searchset([storedPractitioner('d-2')], 'page-3')],
      ['page-3', searchset([storedPractitioner('d-3')], null)],
    ])

    // Act
    const { requests, result } = await runWith(
      searchByIdentifiers('Practitioner', identifiers),
      (form) => pages.get(form['_cursor']) ?? searchset([], null)
    )

    // Assert
    expect(result.map(({ id }) => id)).toEqual(['d-1', 'd-2', 'd-3'])
    expect(requests.map(({ form }) => form)).toEqual([
      { identifier: 'https://cpso.example/licence|A1234', _count: '1000' },
      { identifier: 'https://cpso.example/licence|A1234', _count: '1000', _cursor: 'page-2' },
      { identifier: 'https://cpso.example/licence|A1234', _count: '1000', _cursor: 'page-3' },
    ])
  })

  it('should fail on a match that carries no resource, rather than leave it uncounted', async () => {
    // Arrange
    const identifiers = Array.make(qualified('https://shoppers.example/customer', '1'))

    // Act
    const outcome = await Effect.runPromise(
      Effect.either(searchByIdentifiers('Patient', identifiers)).pipe(
        Effect.provide(clientLayer([], () => searchsetOf([{ search: { mode: 'match' } }], null)))
      )
    )

    // Assert
    expect(outcome).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'MatchWithoutResource', resourceType: 'Patient' },
    })
  })

  it.each(Record.keys(EVERY_SEARCHABLE_TYPE))(
    'should search %s at its own _search endpoint',
    async (resourceType) => {
      // Arrange
      const identifiers = Array.make(qualified('https://example.org/id', '1'))

      // Act
      const { requests } = await runWith(searchByIdentifiers(resourceType, identifiers), () =>
        searchset([], null)
      )

      // Assert
      expect(requests.map(({ url }) => url)).toEqual([`${TEST_ORIGIN}/${resourceType}/_search`])
    }
  )
})

describe('searchAllOfType', () => {
  it('should ask for pages of the given size and stop at the page limit, saying pages were left unread', async () => {
    // Arrange: every page continues to another
    const pageSize = 2

    // Act
    const { requests, result } = await runWith(
      searchAllOfType('Patient', { pageSize, pageLimit: 2 }),
      (form) => {
        const pageToken = form['_cursor'] ?? '0'
        return searchset([storedPatient(`p-${pageToken}`)], `${pageToken}-next`)
      }
    )

    // Assert
    expect({ ids: result.matches.map(({ id }) => id), truncated: result.truncated }).toEqual({
      ids: ['p-0', 'p-0-next'],
      truncated: true,
    })
    expect(requests.map(({ url, form }) => ({ url, form }))).toEqual([
      { url: `${TEST_ORIGIN}/Patient/_search`, form: { _count: '2' } },
      { url: `${TEST_ORIGIN}/Patient/_search`, form: { _count: '2', _cursor: '0-next' } },
    ])
  })

  it('should continue past the first page with the _cursor an HFS next link carries, and say the list is whole', async () => {
    // Arrange: HFS repeats the search in its next link and adds an opaque,
    // percent-encoded `_cursor`
    const cursor = 'eyJwb3MiOjJ9+/='
    const hfsNextLink = `${TEST_ORIGIN}/Patient?_count=2&_cursor=${encodeURIComponent(cursor)}`

    // Act
    const { requests, result } = await runWith(
      searchAllOfType('Patient', { pageSize: 2, pageLimit: 10 }),
      (form) =>
        form['_cursor'] === cursor
          ? searchset([storedPatient('p-3')], null)
          : searchsetLinkingTo([storedPatient('p-1'), storedPatient('p-2')], hfsNextLink)
    )

    // Assert
    expect({ ids: result.matches.map(({ id }) => id), truncated: result.truncated }).toEqual({
      ids: ['p-1', 'p-2', 'p-3'],
      truncated: false,
    })
    expect(requests.map(({ form }) => form)).toEqual([
      { _count: '2' },
      { _count: '2', _cursor: cursor },
    ])
  })
})

// Helpers

const TEST_ORIGIN = 'http://fhir-r4.test'

/** Every searchable type, keyed so the list cannot miss one or name another. */
const EVERY_SEARCHABLE_TYPE = {
  CarePlan: true,
  DiagnosticReport: true,
  DocumentReference: true,
  Goal: true,
  ImagingStudy: true,
  MedicationDispense: true,
  MedicationRequest: true,
  Observation: true,
  Patient: true,
  PlanDefinition: true,
  Practitioner: true,
  Procedure: true,
  ServiceRequest: true,
} as const satisfies Record<SearchableResourceType, true>

const qualified = (
  system: string,
  value: string
): IdentifierAndReference.QualifiedIdentifierType => {
  const identifier = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({
    system,
    value,
  })
  if (!IdentifierAndReference.isQualifiedIdentifier(identifier)) throw new Error('unreachable')
  return identifier
}

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly form: Readonly<Record<string, string>>
}

type Responder = (form: Readonly<Record<string, string>>) => Response

const storedPatient = (id: string): object => ({ resourceType: 'Patient', id })

const storedPractitioner = (id: string): object => ({ resourceType: 'Practitioner', id })

const searchsetOf = (entries: readonly object[], nextPageToken: string | null): Response =>
  new Response(
    JSON.stringify({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: entries,
      link:
        nextPageToken === null
          ? []
          : [{ relation: 'next', url: `${TEST_ORIGIN}/X?_cursor=${nextPageToken}` }],
    }),
    { status: 200, headers: { 'content-type': 'application/fhir+json' } }
  )

const searchset = (resources: readonly object[], nextPageToken: string | null): Response =>
  searchsetOf(
    resources.map((resource) => ({ resource, search: { mode: 'match' } })),
    nextPageToken
  )

/** A searchset of `resources` whose `next` link is `nextUrl` exactly, as the server wrote it. */
const searchsetLinkingTo = (resources: readonly object[], nextUrl: string): Response =>
  new Response(
    JSON.stringify({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: resources.map((resource) => ({ resource, search: { mode: 'match' } })),
      link: [{ relation: 'next', url: nextUrl }],
    }),
    { status: 200, headers: { 'content-type': 'application/fhir+json' } }
  )

const clientLayer = (
  records: RecordedRequest[],
  responder: Responder
): Layer.Layer<FhirR4ResourcesHttpApiClient> =>
  FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.mapRequest(
          HttpClient.make((request) => {
            const raw =
              request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
            const form = Object.fromEntries(new URLSearchParams(raw))
            records.push({ method: request.method, url: request.url, form })
            return Effect.succeed(HttpClientResponse.fromWeb(request, responder(form)))
          }),
          HttpClientRequest.prependUrl(TEST_ORIGIN)
        )
      )
    )
  )

const runWith = async <A, E>(
  search: Effect.Effect<A, E, FhirR4ResourcesHttpApiClient>,
  responder: Responder
): Promise<{ readonly requests: readonly RecordedRequest[]; readonly result: A }> => {
  const records: RecordedRequest[] = []
  const result = await Effect.runPromise(
    search.pipe(Effect.provide(clientLayer(records, responder)))
  )
  return { requests: records, result }
}
