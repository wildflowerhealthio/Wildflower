import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Either, Layer, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { IdentifierAndReference } from '../data-types/index.ts'
import { FhirResourceSchema, literalReferenceOf, LogicalReference } from '../resources/index.ts'
import { FhirR4ResourcesHttpApiClient, MatchQuery, ResourceMatch } from './index.ts'

const RUNS = numRunsFor({ base: 50 })

const CERTAIN_ONLY: ResourceMatch.Options = { onlyCertainMatches: true, count: Option.none() }
const EVERY_GRADE: ResourceMatch.Options = { onlyCertainMatches: false, count: Option.none() }

describe('ResourceMatch.matchAll: the identifier stage', () => {
  it('should search each type once, every identifier of every query of it, and nothing for a type with none', async () => {
    // Arrange
    const queries = [
      queryOf(patientWire({ identifier: [SHOPPERS_1, REXALL_9] })),
      MatchQuery.fromLogicalReference(logicalReference('Patient', SHOPPERS_2)),
      queryOf(patientWire({ name: [{ family: 'Keyless' }] })),
      MatchQuery.fromLogicalReference(logicalReference('Practitioner', LICENCE_7)),
      queryOf(practitionerWire({ identifier: [LICENCE_7] })),
      MatchQuery.fromLogicalReference(logicalReference('Binary', SHOPPERS_1)),
    ]
    const server = inMemoryServer([
      patientWire({ id: 'p-1', identifier: [SHOPPERS_1] }),
      patientWire({ id: 'p-2', identifier: [SHOPPERS_2] }),
      practitionerWire({ id: 'd-7', identifier: [LICENCE_7] }),
    ])

    // Act
    const { requests, result } = await runWith(
      ResourceMatch.matchAll(queries, CERTAIN_ONLY),
      server
    )

    // Assert
    // The searches of different types run concurrently, so their order is not pinned.
    expect(requests).toHaveLength(2)
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          url: '/Patient/_search',
          form: {
            identifier:
              'https://shoppers.example/customer|1,https://rexall.example/uid|9,https://shoppers.example/customer|2',
            _count: '1000',
          },
        },
        {
          url: '/Practitioner/_search',
          form: { identifier: 'https://cpso.example/licence|7', _count: '1000' },
        },
      ])
    )
    expect(result.map(candidateRefs)).toEqual([
      ['Patient/p-1 certain by identifier'],
      ['Patient/p-2 certain by identifier'],
      [],
      ['Practitioner/d-7 certain by identifier'],
      ['Practitioner/d-7 certain by identifier'],
      [],
    ])
  })

  it('should send nothing for no query with an identifier', async () => {
    const { requests, result } = await runWith(
      ResourceMatch.matchAll([queryOf(patientWire({}))], CERTAIN_ONLY),
      inMemoryServer([])
    )

    expect({ requests, result }).toEqual({ requests: [], result: [[]] })
  })

  it('should give a hit to every query whose identifier it carries, and one carrying none to nobody', async () => {
    // Arrange: the server answers with a hit no query named, too
    const queries = [
      MatchQuery.fromLogicalReference(logicalReference('Patient', SHOPPERS_1)),
      MatchQuery.fromLogicalReference(logicalReference('Patient', REXALL_9)),
    ]
    const shared = patientWire({ id: 'shared', identifier: [SHOPPERS_1, REXALL_9] })
    const unrelated = patientWire({ id: 'unrelated', identifier: [SHOPPERS_2] })

    // Act
    const { result } = await runWith(ResourceMatch.matchAll(queries, CERTAIN_ONLY), () =>
      searchset([shared, unrelated])
    )

    // Assert
    expect(result.map(candidateRefs)).toEqual([
      ['Patient/shared certain by identifier'],
      ['Patient/shared certain by identifier'],
    ])
  })

  it('should demote every candidate of a query whose identifiers name several stored records to probable, before count', async () => {
    // Arrange
    const query = queryOf(patientWire({ identifier: [SHOPPERS_1, SHOPPERS_2] }))
    const server = inMemoryServer([
      patientWire({ id: 'p-1', identifier: [SHOPPERS_1] }),
      patientWire({ id: 'p-2', identifier: [SHOPPERS_2] }),
    ])

    // Act
    const every = await runWith(ResourceMatch.matchAll([query], EVERY_GRADE), server)
    const one = await runWith(
      ResourceMatch.matchAll([query], { ...EVERY_GRADE, count: Option.some(1) }),
      server
    )

    // Assert: still found by identifier, so no name stage
    expect({
      every: every.result.map(candidateRefs),
      one: one.result.map(candidateRefs),
      urls: [...every.requests, ...one.requests].map(({ url }) => url),
    }).toEqual({
      every: [['Patient/p-1 probable by identifier', 'Patient/p-2 probable by identifier']],
      one: [['Patient/p-1 probable by identifier']],
      urls: ['/Patient/_search', '/Patient/_search'],
    })
  })
})

describe('ResourceMatch.matchAll: the name stage', () => {
  it('should list each person type once, every record of it, only for queries nothing was found for by identifier', async () => {
    // Arrange
    const queries = [
      queryOf(patientWire({ identifier: [SHOPPERS_1], name: [ANN_BROWN], birthDate: BORN })),
      queryOf(patientWire({ name: [ANN_BROWN], birthDate: BORN })),
      queryOf(patientWire({ name: [{ family: 'BROWN', given: ['Beth'] }], birthDate: BORN })),
      queryOf(patientWire({ name: [ANN_BROWN] })),
      queryOf(practitionerWire({ name: [{ text: 'DR J BROWN' }] })),
      queryOf(practitionerWire({ name: [{ family: 'Brown', given: ['Jonathan'] }] })),
    ]
    const server = inMemoryServer([
      patientWire({ id: 'p-1', identifier: [SHOPPERS_1], name: [ANN_BROWN], birthDate: BORN }),
      patientWire({ id: 'p-ann', name: [ANN_BROWN], birthDate: BORN }),
      patientWire({
        id: 'p-browning',
        name: [{ family: 'Browning', given: ['Ann'] }],
        birthDate: BORN,
      }),
      patientWire({ id: 'p-older', name: [ANN_BROWN], birthDate: '1950-01-01' }),
      practitionerWire({ id: 'd-jon', name: [{ family: 'Brown', given: ['Jonathan'] }] }),
    ])

    // Act
    const { requests, result } = await runWith(ResourceMatch.matchAll(queries, EVERY_GRADE), server)

    // Assert
    const [identifierSearch, ...listings] = requests
    expect(identifierSearch).toEqual({
      url: '/Patient/_search',
      form: { identifier: 'https://shoppers.example/customer|1', _count: '1000' },
    })
    // The listings run concurrently, so their order is not pinned.
    expect(listings).toHaveLength(2)
    expect(listings).toEqual(
      expect.arrayContaining([
        { url: '/Patient/_search', form: { _count: '1000' } },
        { url: '/Practitioner/_search', form: { _count: '1000' } },
      ])
    )
    expect(result.map(candidateRefs)).toEqual([
      ['Patient/p-1 certain by identifier'],
      [
        'Patient/p-1 probable by name',
        'Patient/p-ann probable by name',
        'Patient/p-browning possible by name',
      ],
      ['Patient/p-1 possible by name', 'Patient/p-ann possible by name'],
      [],
      ['Practitioner/d-jon possible by name'],
      ['Practitioner/d-jon probable by name'],
    ])
  })

  it("should read every page of a type's records", async () => {
    // Arrange: one record a page, the match on the last
    const query = queryOf(patientWire({ name: [ANN_BROWN], birthDate: BORN }))
    const server = inMemoryServer(
      [
        patientWire({ id: 'p-0', name: [{ family: 'Smith', given: ['Zoe'] }], birthDate: BORN }),
        patientWire({ id: 'p-1', name: [{ family: 'Jones', given: ['Liz'] }], birthDate: BORN }),
        patientWire({ id: 'p-ann', name: [ANN_BROWN], birthDate: BORN }),
      ],
      { pageSize: 1 }
    )

    // Act
    const { requests, result } = await runWith(ResourceMatch.matchAll([query], EVERY_GRADE), server)

    // Assert
    expect({ forms: requests.map(({ form }) => form), result: result.map(candidateRefs) }).toEqual({
      forms: [
        { _count: '1000' },
        { _count: '1000', _cursor: '1' },
        { _count: '1000', _cursor: '2' },
      ],
      result: [['Patient/p-ann probable by name']],
    })
  })

  it('should list nothing when every query was found by identifier', async () => {
    const query = queryOf(
      patientWire({ identifier: [SHOPPERS_1], name: [ANN_BROWN], birthDate: BORN })
    )
    const server = inMemoryServer([patientWire({ id: 'p-1', identifier: [SHOPPERS_1] })])

    const { requests } = await runWith(ResourceMatch.matchAll([query], EVERY_GRADE), server)

    expect(requests.map(({ form }) => form)).toEqual([
      { identifier: 'https://shoppers.example/customer|1', _count: '1000' },
    ])
  })

  it('should list nothing when only certain matches are asked for', async () => {
    const query = queryOf(
      patientWire({ identifier: [SHOPPERS_1], name: [ANN_BROWN], birthDate: BORN })
    )
    const server = inMemoryServer([
      patientWire({ id: 'p-ann', name: [ANN_BROWN], birthDate: BORN }),
    ])

    const { requests, result } = await runWith(
      ResourceMatch.matchAll([query], CERTAIN_ONLY),
      server
    )

    expect({ forms: requests.map(({ form }) => form), result }).toEqual({
      forms: [{ identifier: 'https://shoppers.example/customer|1', _count: '1000' }],
      result: [[]],
    })
  })

  it('should list nothing for a logical reference, which carries no record', async () => {
    const query = MatchQuery.fromLogicalReference(logicalReference('Patient', SHOPPERS_1))

    const { requests } = await runWith(
      ResourceMatch.matchAll([query], EVERY_GRADE),
      inMemoryServer([patientWire({ id: 'p-ann', name: [ANN_BROWN], birthDate: BORN })])
    )

    expect(requests.map(({ form }) => form)).toEqual([
      { identifier: 'https://shoppers.example/customer|1', _count: '1000' },
    ])
  })

  it('should give the best grades first, as many as count allows', async () => {
    // Arrange
    const query = queryOf(patientWire({ name: [ANN_BROWN], birthDate: BORN }))
    const server = inMemoryServer([
      patientWire({ id: 'p-beth', name: [{ family: 'Brown', given: ['Beth'] }], birthDate: BORN }),
      patientWire({ id: 'p-ann', name: [ANN_BROWN], birthDate: BORN }),
    ])

    // Act
    const every = await runWith(ResourceMatch.matchAll([query], EVERY_GRADE), server)
    const best = await runWith(
      ResourceMatch.matchAll([query], { ...EVERY_GRADE, count: Option.some(1) }),
      server
    )

    // Assert
    expect([every.result.map(candidateRefs), best.result.map(candidateRefs)]).toEqual([
      [['Patient/p-ann probable by name', 'Patient/p-beth possible by name']],
      [['Patient/p-ann probable by name']],
    ])
  })
})

describe('ResourceMatch.matchAll: failures', () => {
  it('should fail with a failed identifier search, not find no match', async () => {
    const query = MatchQuery.fromLogicalReference(logicalReference('Patient', SHOPPERS_1))

    const outcome = await failureOf(
      ResourceMatch.matchAll([query], CERTAIN_ONLY),
      () => new Response('', { status: 503 })
    )

    expect(outcome).toMatchObject({ _tag: 'ServiceUnavailable' })
  })

  it("should fail with a failed listing of a type's records, not find no match", async () => {
    const query = queryOf(patientWire({ name: [ANN_BROWN], birthDate: BORN }))

    const outcome = await failureOf(
      ResourceMatch.matchAll([query], EVERY_GRADE),
      () => new Response('', { status: 503 })
    )

    expect(outcome).toMatchObject({ _tag: 'ServiceUnavailable' })
  })
})

describe('ResourceMatch.matchAll: batching', () => {
  it('property: matching a batch gives each query what matching it alone gives', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(storedWireArbitrary, { maxLength: 8 }),
        fc.array(queryArbitrary, { maxLength: 6 }),
        optionsArbitrary,
        async (storedWithoutIds, queries, options) => {
          const server = inMemoryServer(
            storedWithoutIds.map((stored, index) => ({ ...stored, id: `s-${index}` }))
          )

          const batched = await runWith(ResourceMatch.matchAll(queries, options), server)
          const alone = await Promise.all(
            queries.map((query) => runWith(ResourceMatch.matchAll([query], options), server))
          )

          expect(batched.result.map(candidateRefs)).toEqual(
            alone.map(({ result }) => result.flatMap(candidateRefs))
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

// Helpers

interface Wire {
  readonly resourceType: string
  readonly id?: string
  readonly identifier?: readonly { readonly system: string; readonly value: string }[]
  readonly name?: readonly {
    readonly family?: string
    readonly given?: readonly string[]
    readonly text?: string
  }[]
  readonly birthDate?: string
}

const SHOPPERS_1 = { system: 'https://shoppers.example/customer', value: '1' }
const SHOPPERS_2 = { system: 'https://shoppers.example/customer', value: '2' }
const REXALL_9 = { system: 'https://rexall.example/uid', value: '9' }
const LICENCE_7 = { system: 'https://cpso.example/licence', value: '7' }
const ANN_BROWN = { family: 'Brown', given: ['Ann'] }
const BORN = '1980-02-03'

const patientWire = (fields: Omit<Wire, 'resourceType'>): Wire => ({
  resourceType: 'Patient',
  ...fields,
})

const practitionerWire = (fields: Omit<Wire, 'resourceType'>): Wire => ({
  resourceType: 'Practitioner',
  ...fields,
})

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

const queryOf = (wire: Wire): MatchQuery.Type => MatchQuery.fromResource(decodeResource(wire))

const logicalReference = (
  resourceType: LogicalReference.Type['resourceType'],
  identifier: { readonly system: string; readonly value: string }
): LogicalReference.Type => {
  const decoded = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)(identifier)
  if (!IdentifierAndReference.isQualifiedIdentifier(decoded)) throw new Error('unreachable')
  return LogicalReference.make(resourceType, decoded)
}

const candidateRefs = (candidates: readonly ResourceMatch.Candidate[]): readonly string[] =>
  candidates.map(({ resource, grade, by }) => `${literalReferenceOf(resource)} ${grade} by ${by}`)

// The in-memory server: a type's _search, by identifier or every record, as HFS answers it

interface RecordedRequest {
  readonly url: string
  /** The search's form parameters. */
  readonly form: Readonly<Record<string, string>>
}

type Server = (request: { readonly url: string; readonly body: string }) => Response

/** The `system|value` tokens of a token search value, each half unescaped. */
const tokensOf = (value: string): readonly string[] => {
  const tokens: string[] = []
  let current = ''
  for (let index = 0; index < value.length; index++) {
    const character = value.charAt(index)
    if (character === '\\') {
      current += value.charAt(index + 1)
      index++
    } else if (character === ',') {
      tokens.push(current)
      current = ''
    } else {
      current += character
    }
  }
  return [...tokens, current]
}

const carriesAnyOf = (stored: Wire, tokens: readonly string[]): boolean =>
  (stored.identifier ?? []).some(({ system, value }) => tokens.includes(`${system}|${value}`))

/**
 * A server holding `stored`: a search with `identifier` answers with the
 * records carrying any of its tokens, one without with every record of the
 * type, `pageSize` to a page (every match on one page by default), a `next`
 * link carrying the offset as `_cursor`.
 */
const inMemoryServer =
  (stored: readonly Wire[], { pageSize = Number.POSITIVE_INFINITY } = {}): Server =>
  ({ url, body }) => {
    const [, resourceType = ''] = /^\/(\w+)\/_search$/u.exec(url) ?? []
    const form = new URLSearchParams(body)
    const identifier = form.get('identifier')
    const matches = stored.filter(
      (resource) =>
        resource.resourceType === resourceType &&
        (identifier === null || carriesAnyOf(resource, tokensOf(identifier)))
    )
    const offset = Number(form.get('_cursor') ?? '0')
    const end = offset + pageSize
    return fhirJson({
      ...searchsetOf(matches.slice(offset, end)),
      link:
        end < matches.length ? [{ relation: 'next', url: `${resourceType}?_cursor=${end}` }] : [],
    })
  }

const searchsetOf = (resources: readonly object[]): object => ({
  resourceType: 'Bundle',
  type: 'searchset',
  entry: resources.map((resource) => ({ resource, search: { mode: 'match' } })),
})

const fhirJson = (body: object): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/fhir+json' },
  })

const searchset = (resources: readonly object[]): Response => fhirJson(searchsetOf(resources))

const TEST_ORIGIN = 'http://fhir-r4.test'

const clientLayer = (
  records: RecordedRequest[],
  server: Server
): Layer.Layer<FhirR4ResourcesHttpApiClient> =>
  FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.mapRequest(
          HttpClient.make((request) => {
            const body =
              request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
            const url = request.url.slice(TEST_ORIGIN.length)
            records.push({ url, form: Object.fromEntries(new URLSearchParams(body)) })
            return Effect.succeed(HttpClientResponse.fromWeb(request, server({ url, body })))
          }),
          HttpClientRequest.prependUrl(TEST_ORIGIN)
        )
      )
    )
  )

const runWith = async <A, E>(
  match: Effect.Effect<A, E, FhirR4ResourcesHttpApiClient>,
  server: Server
): Promise<{ readonly requests: readonly RecordedRequest[]; readonly result: A }> => {
  const records: RecordedRequest[] = []
  const result = await Effect.runPromise(match.pipe(Effect.provide(clientLayer(records, server))))
  return { requests: records, result }
}

const failureOf = async <A, E>(
  match: Effect.Effect<A, E, FhirR4ResourcesHttpApiClient>,
  server: Server
): Promise<E | null> => {
  const outcome = await Effect.runPromise(
    Effect.either(match).pipe(Effect.provide(clientLayer([], server)))
  )
  return Either.getLeft(outcome).pipe(Option.getOrNull)
}

// Arbitraries: few systems, values and names, so queries and stored records collide

const identifierArbitrary = fc.record({
  system: fc.constantFrom('https://a.example/id', 'https://b.example/id'),
  value: fc.constantFrom('1', '2', '3'),
})

const nameArbitrary = fc.oneof(
  fc.record({
    family: fc.constantFrom('Brown', 'Browning', 'BRÖWN'),
    given: fc.subarray(['Ann', 'Jonathan', 'J']),
  }),
  fc
    .tuple(fc.constantFrom('Dr', 'Ann', 'J'), fc.constantFrom('Brown', 'Browning'))
    .map(([first, family]) => ({ text: `${first} ${family}` }))
)

const storedWireArbitrary: fc.Arbitrary<Wire> = fc.record(
  {
    resourceType: fc.constantFrom('Patient', 'Practitioner'),
    identifier: fc.array(identifierArbitrary, { maxLength: 2 }),
    name: fc.array(nameArbitrary, { maxLength: 2 }),
    birthDate: fc.constantFrom('1980-02-03', '1990-05-06'),
  },
  { requiredKeys: ['resourceType'] }
)

const queryArbitrary: fc.Arbitrary<MatchQuery.Type> = fc.oneof(
  storedWireArbitrary.map(queryOf),
  fc
    .tuple(fc.constantFrom('Patient' as const, 'Practitioner' as const), identifierArbitrary)
    .map(([resourceType, identifier]) =>
      MatchQuery.fromLogicalReference(logicalReference(resourceType, identifier))
    )
)

const optionsArbitrary: fc.Arbitrary<ResourceMatch.Options> = fc.record({
  onlyCertainMatches: fc.boolean(),
  count: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }).map(Option.fromNullable),
})
