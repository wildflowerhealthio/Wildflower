import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import {
  FhirResourceSchema,
  type FhirResourceWithId,
  literalReferenceOf,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Exit, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportMatch from './import-match.ts'

/**
 * Drives `ImportMatch` over the typed FHIR client and an in-memory server
 * that answers `POST <Type>/_search` as HFS does, by `identifier`, `birthdate`
 * (born on any of its dates) or `name` (a name part starting with any of its
 * values, case and accents folded), recording each search it is sent.
 */

const TEST_ORIGIN = 'http://fhir.test'
const SOURCE = 'https://source.example/id'
const DEVICE = 'https://device.example/id'

/** A stored or imported record of the wire `fields`, decoded. */
const record = (fields: object): FhirResourceWithId =>
  Schema.decodeUnknownSync(StoredResourceSchema)(fields)

const tyra = (id: string, system: string, value: string): FhirResourceWithId =>
  record({
    resourceType: 'Patient',
    id,
    identifier: [{ system, value }],
    name: [{ family: 'Banks', given: ['Tyra'] }],
    birthDate: '1990-01-02',
  })

const observation = (id: string, value: string): FhirResourceWithId =>
  record({
    resourceType: 'Observation',
    id,
    identifier: [{ system: SOURCE, value }],
    status: 'final',
    code: { text: 'A1c' },
  })

/** The values of a search parameter ORing several, with no escaped characters in them. */
const valuesOf = (value: string): readonly string[] => value.split(',')

/** `text` as HFS indexes a name part: lower-cased, without diacritics. */
const folded = (text: string): string =>
  text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase()

/** Whether a record passes the search's filter on `parameter`, or `parameter` is not in `form`. */
const passes = (
  form: URLSearchParams,
  parameter: string,
  filter: (values: readonly string[]) => boolean
): boolean => {
  const value = form.get(parameter)
  return value === null || filter(valuesOf(value))
}

/** A stored record as the server holds it: its wire JSON, the fields the searches read. */
interface Wire {
  readonly resourceType: string
  readonly identifier?: readonly { readonly system?: string; readonly value?: string }[]
  readonly birthDate?: string
  readonly name?: readonly {
    readonly family?: string
    readonly given?: readonly string[]
    readonly text?: string
  }[]
}

/** `resource` as the server holds it. */
const wireOf = (resource: FhirResourceWithId): Wire =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the encoded resource carries at least these fields, each as FHIR's JSON writes it
  Schema.encodeSync(FhirResourceSchema)(resource) as Wire

/** Whether `stored` carries any of the `system|value` `tokens`. */
const carriesAnyOf = (stored: Wire, tokens: readonly string[]): boolean =>
  (stored.identifier ?? []).some(({ system, value }) => tokens.includes(`${system}|${value}`))

/** Whether `stored` is born on any of `birthDates`, compared as written. */
const bornOnAnyOf = (stored: Wire, birthDates: readonly string[]): boolean =>
  stored.birthDate !== undefined && birthDates.includes(stored.birthDate)

/**
 * Whether any of `values` starts a name part of `stored` as HFS indexes them:
 * its family, each given name and its text, each a value of its own.
 */
const nameStartsWithAnyOf = (stored: Wire, values: readonly string[]): boolean =>
  (stored.name ?? [])
    .flatMap(({ family, given = [], text }) => [family, ...given, text])
    .filter((part) => part !== undefined)
    .some((part) => values.some((value) => folded(part).startsWith(folded(value))))

/** A search as the server records it: `<Type>` and its identifier tokens, or its `birthdate=` or `name=` values, or `every`. */
const describeSearch = (resourceType: string, form: URLSearchParams): string => {
  const identifier = form.get('identifier')
  const birthdate = form.get('birthdate')
  const name = form.get('name')
  if (identifier !== null) return `${resourceType} ${identifier}`
  if (birthdate !== null) return `${resourceType} birthdate=${birthdate}`
  if (name !== null) return `${resourceType} name=${name}`
  return `${resourceType} every`
}

/** A server holding `stored`, its client layer, and the searches sent to it ({@link describeSearch}). */
const inMemoryServer = (
  stored: readonly FhirResourceWithId[]
): { readonly layer: Layer.Layer<FhirR4ResourcesHttpApiClient>; readonly searches: string[] } => {
  const searches: string[] = []
  const httpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((request) => {
        const body =
          request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
        const [, resourceType = ''] = /\/(\w+)\/_search$/u.exec(request.url) ?? []
        const form = new URLSearchParams(body)
        searches.push(describeSearch(resourceType, form))
        const matches = stored
          .map(wireOf)
          .filter(
            (resource) =>
              resource.resourceType === resourceType &&
              passes(form, 'identifier', (tokens) => carriesAnyOf(resource, tokens)) &&
              passes(form, 'birthdate', (birthDates) => bornOnAnyOf(resource, birthDates)) &&
              passes(form, 'name', (values) => nameStartsWithAnyOf(resource, values))
          )
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                resourceType: 'Bundle',
                type: 'searchset',
                entry: matches.map((resource) => ({
                  resource,
                  search: { mode: 'match' },
                })),
              }),
              { status: 200, headers: { 'content-type': 'application/fhir+json' } }
            )
          )
        )
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )
  return { layer: FhirR4ResourcesHttpApiClient.layer.pipe(Layer.provide(httpClient)), searches }
}

/** `records` matched against a server holding `stored`, and the searches it took. */
const findAgainst = async (
  records: readonly FhirResourceWithId[],
  stored: readonly FhirResourceWithId[]
): Promise<{ readonly importMatch: ImportMatch.Type; readonly searches: readonly string[] }> => {
  const server = inMemoryServer(stored)
  const importMatch = await Effect.runPromise(
    ImportMatch.find(records).pipe(Effect.provide(server.layer))
  )
  return { importMatch, searches: server.searches }
}

/** A matched copy as `<tag>` or `Found <literal reference>`. */
const describeCopy = (matchedCopy: ImportMatch.MatchedCopy): string =>
  ImportMatch.MatchedCopy.$match(matchedCopy, {
    Found: ({ copy }) => `Found ${literalReferenceOf(copy)}`,
    NotFound: () => 'NotFound',
    NotSearched: () => 'NotSearched',
  })

describe('ImportMatch.find', () => {
  it('should search every record of a type in one identifier search, and Patients by birth date only for one nothing was found for', async () => {
    // Arrange
    const records = [
      tyra('p-1', SOURCE, 'p-1'),
      observation('o-1', 'o-1'),
      observation('o-2', 'o-2'),
    ]

    // Act
    const { searches } = await findAgainst(records, [])

    // Assert
    expect(searches.toSorted()).toEqual(
      [
        `Patient ${SOURCE}|p-1`,
        `Observation ${SOURCE}|o-1,${SOURCE}|o-2`,
        'Patient birthdate=1990-01-02',
      ].toSorted()
    )
  })

  it('should search no birth date when every Patient is found by identifier', async () => {
    // Act
    const { searches } = await findAgainst(
      [tyra('p-1', SOURCE, 'p-1')],
      [tyra('p-1', SOURCE, 'p-1')]
    )

    // Assert
    expect(searches).toEqual([`Patient ${SOURCE}|p-1`])
  })

  it('should give each record its candidates by its literal reference, a namesake graded probable', async () => {
    // Arrange
    const imported = tyra('p-1', SOURCE, 'p-1')
    const stored = tyra('s-1', DEVICE, 's-1')

    // Act
    const { importMatch } = await findAgainst([imported], [stored])

    // Assert
    expect(
      ImportMatch.candidatesOf(importMatch, imported).map(({ resource, grade, by }) => ({
        reference: literalReferenceOf(resource),
        grade,
        by,
      }))
    ).toEqual([{ reference: 'Patient/s-1', grade: 'probable', by: 'name' }])
  })

  it('should match a record once however many times it is given', async () => {
    // Act
    const { searches } = await findAgainst(
      [observation('o-1', 'o-1'), observation('o-1', 'o-1')],
      []
    )

    // Assert
    expect(searches).toEqual([`Observation ${SOURCE}|o-1`])
  })

  it('should fail when a search fails, rather than read it as no match', async () => {
    // Arrange
    const failing = FhirR4ResourcesHttpApiClient.layer.pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response('down', { status: 503 }))
            )
          )
        )
      )
    )

    // Act
    const exit = await Effect.runPromiseExit(
      ImportMatch.find([observation('o-1', 'o-1')]).pipe(Effect.provide(failing))
    )

    // Assert
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('ImportMatch.matchedCopyOf', () => {
  it('should find the one stored record carrying the record’s identifier, under whatever id', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { importMatch } = await findAgainst([imported], [observation('elsewhere', 'o-1')])

    // Act / Assert
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, imported))).toBe(
      'Found Observation/elsewhere'
    )
  })

  it('should take the copy under the record’s own id when its identifiers name several', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { importMatch } = await findAgainst(
      [imported],
      [observation('elsewhere', 'o-1'), observation('o-1', 'o-1')]
    )

    // Act / Assert
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, imported))).toBe(
      'Found Observation/o-1'
    )
  })

  it('should find none when its identifiers name several stored records, none under its own id', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { importMatch } = await findAgainst(
      [imported],
      [observation('a', 'o-1'), observation('b', 'o-1')]
    )

    // Act / Assert
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, imported))).toBe('NotFound')
  })

  it('should find none for a record whose identifiers name nothing stored', async () => {
    // Arrange
    const imported = observation('o-1', 'o-1')
    const { importMatch } = await findAgainst([imported], [])

    // Act / Assert
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, imported))).toBe('NotFound')
  })

  it('should not find a namesake as a copy: the diff compares by identifier only', async () => {
    // Arrange
    const imported = tyra('p-1', SOURCE, 'p-1')
    const { importMatch } = await findAgainst([imported], [tyra('s-1', DEVICE, 's-1')])

    // Act / Assert
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, imported))).toBe('NotFound')
  })

  it('should not speak for a record carrying an identifier the match never searched', async () => {
    // Arrange: the record as resolved, having assumed a stored copy's own identifier
    const imported = tyra('p-1', SOURCE, 'p-1')
    const { importMatch } = await findAgainst([imported], [])
    const resolved = record({
      resourceType: 'Patient',
      id: 'p-1',
      identifier: [
        { system: SOURCE, value: 'p-1' },
        { system: DEVICE, value: 's-1' },
      ],
    })

    // Act / Assert
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, resolved))).toBe('NotSearched')
  })

  it('should not speak for a record with no identifier, nor a Binary', async () => {
    // Arrange
    const keyless = record({ resourceType: 'Observation', id: 'o-9', status: 'final', code: {} })
    const binary = record({ resourceType: 'Binary', id: 'b-1', contentType: 'text/plain' })
    const { importMatch, searches } = await findAgainst([keyless, binary], [])

    // Act / Assert
    expect(searches).toEqual([])
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, keyless))).toBe('NotSearched')
    expect(describeCopy(ImportMatch.matchedCopyOf(importMatch, binary))).toBe('NotSearched')
  })

  it('should not speak for anything when nothing was matched', () => {
    expect(
      describeCopy(ImportMatch.matchedCopyOf(ImportMatch.empty, observation('o-1', 'o-1')))
    ).toBe('NotSearched')
  })
})
