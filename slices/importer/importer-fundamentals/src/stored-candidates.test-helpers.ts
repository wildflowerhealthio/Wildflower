import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import {
  FhirResourceSchema,
  type FhirResourceWithId,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Layer, Schema } from 'effect'

import * as StoredCandidates from './stored-candidates.ts'

/**
 * Drives `StoredCandidates.find` over the typed FHIR client and an in-memory
 * server that answers `POST <Type>/_search` as HFS does, by `identifier`,
 * `birthdate` (born on any of its dates) or `name` (a name part starting
 * with any of its values, case and accents folded), recording each search
 * it is sent.
 */

const TEST_ORIGIN = 'http://fhir.test'
const SOURCE = 'https://source.example/id'
const DEVICE = 'https://device.example/id'

/** A stored or imported resource of the wire `fields`, decoded. */
const decoded = (fields: object): FhirResourceWithId =>
  Schema.decodeUnknownSync(StoredResourceSchema)(fields)

const tyra = (id: string, system: string, value: string): FhirResourceWithId =>
  decoded({
    resourceType: 'Patient',
    id,
    identifier: [{ system, value }],
    name: [{ family: 'Banks', given: ['Tyra'] }],
    birthDate: '1990-01-02',
  })

const observation = (id: string, value: string): FhirResourceWithId =>
  decoded({
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

/** Whether a resource passes the search's filter on `parameter`, or `parameter` is not in `form`. */
const passes = (
  form: URLSearchParams,
  parameter: string,
  filter: (values: readonly string[]) => boolean
): boolean => {
  const value = form.get(parameter)
  return value === null || filter(valuesOf(value))
}

/** A stored resource as the server holds it: its wire JSON, the fields the searches read. */
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

/** The stored candidates of `resources` against a server holding `stored`, and the searches it took. */
const findAgainst = async (
  resources: readonly FhirResourceWithId[],
  stored: readonly FhirResourceWithId[]
): Promise<{
  readonly storedCandidates: StoredCandidates.Type
  readonly searches: readonly string[]
}> => {
  const server = inMemoryServer(stored)
  const storedCandidates = await Effect.runPromise(
    StoredCandidates.find(resources).pipe(Effect.provide(server.layer))
  )
  return { storedCandidates, searches: server.searches }
}

export { decoded, DEVICE, findAgainst, observation, SOURCE, tyra }
