import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  FhirResourceSchema,
  type FhirResourceWithId,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  type FormatDecode,
  type ImportedCopy,
  type PickedFile,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Either, Layer, Option, Schema } from 'effect'

/**
 * Builders for the import plan's stage tests: the test format, its one
 * picked file, the records it decodes, copies of them, and an in-memory
 * FHIR server that answers `POST <Type>/_search` by `identifier` (every
 * stored resource of the type for a name-stage search) and a `POST /` batch
 * of reads by literal reference, recording each request.
 */

const TEST_ORIGIN = 'http://fhir.test'
const SOURCE = 'https://source.example/id'
const NAMES = 'https://pharmacy.example/practitioner-name'

const sourceFileFormat: PickedFile.FormatValue = {
  coding: { system: 'https://example.test/fhir/CodeSystem/source-file', code: 'example' },
  contentType: 'application/octet-stream',
  descriptionPrefix: 'Example: ',
}

const PICKED_FILE: PickedFile.Type = {
  id: '0:a.test',
  fileName: 'a.test',
  bytes: new Uint8Array([1, 2, 3]),
}

/** A detached resource of the wire `fields`. */
const detached = (fields: object): DetachedResource.Type =>
  Either.getOrThrow(DetachedResource.decodeUnknownEither(FhirResourceSchema)(fields))

/** A stored resource of the wire `fields`. */
const stored = (fields: object): FhirResourceWithId =>
  Schema.decodeUnknownSync(StoredResourceSchema)(fields)

const tyraWire = {
  resourceType: 'Patient',
  identifier: [{ system: SOURCE, value: 'tyra' }],
  name: [{ family: 'Ashford', given: ['Tyra'] }],
  birthDate: '1990-01-02',
}

const observationWire = {
  resourceType: 'Observation',
  identifier: [{ system: SOURCE, value: 'a1c-1' }],
  status: 'final',
  code: { text: 'A1c' },
}

const prescriptionWire = {
  resourceType: 'MedicationRequest',
  identifier: [{ system: SOURCE, value: 'rx-1' }],
  status: 'active',
  intent: 'order',
  medicationCodeableConcept: { text: 'Metformin' },
  subject: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
  requester: {
    type: 'Practitioner',
    identifier: { system: NAMES, value: 'Dr. Brown' },
    display: 'Dr. Brown',
  },
}

/** The id the import derives for the record of `resourceType` keyed by `value` in {@link SOURCE}. */
const derivedId = (resourceType: string, value: string): string =>
  localResourceId(SOURCE, resourceType, value)

/** The copy of `resource` the test's one file brings under `localKey`. */
const copyOf = (resource: DetachedResource.Type, localKey: string): ImportedCopy.Type => ({
  origin: { format: 'test', pickedFiles: [PICKED_FILE] },
  reviewKey: `${PICKED_FILE.id}/${localKey}`,
  title: localKey,
  isImplied: false,
  resource,
  sourceUrl: Option.none(),
  stageId: Option.match(DetachedResource.keyIdentifierOf(resource), {
    onNone: () => ({ _tag: 'Minted', id: `minted/${localKey}` }) as const,
    onSome: ({ value }) =>
      ({ _tag: 'Derived', id: derivedId(resource.resourceType, value) }) as const,
  }),
})

/** A stored resource as the server holds it: its wire JSON. */
interface Wire {
  readonly resourceType: string
  readonly id: string
  readonly identifier?: readonly { readonly system?: string; readonly value?: string }[]
}

const wireOf = (resource: FhirResourceWithId): Wire =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the encoded resource carries at least these fields
  Schema.encodeSync(FhirResourceSchema)(resource) as Wire

/** A batch request's GET urls; the test sends nothing else to `/`. */
const batchUrlsOf = (raw: string): readonly string[] => {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- the body this suite's own batch carries
  const bundle: { readonly entry: readonly { readonly request: { readonly url: string } }[] } =
    JSON.parse(raw)
  return bundle.entry.map(({ request }) => request.url)
}

/** The answer to a search: the stored resources of its type carrying any of its identifier tokens, or, for a name-stage search, every one. */
const searchAnswer = (
  storedWires: readonly Wire[],
  resourceType: string,
  form: URLSearchParams
): object => {
  const identifier = form.get('identifier')
  const tokens = identifier === null ? null : identifier.split(',')
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: storedWires
      .filter(
        (resource) =>
          resource.resourceType === resourceType &&
          (tokens === null ||
            (resource.identifier ?? []).some(({ system, value }) =>
              tokens.includes(`${system}|${value}`)
            ))
      )
      .map((resource) => ({ resource, search: { mode: 'match' } })),
  }
}

/** The answer to a batch of reads: each stored resource under its literal reference, else a 404. */
const batchAnswer = (storedWires: readonly Wire[], urls: readonly string[]): object => ({
  resourceType: 'Bundle',
  type: 'batch-response',
  entry: urls.map((url) => {
    const found = storedWires.find(({ resourceType, id }) => `${resourceType}/${id}` === url)
    return found === undefined
      ? { response: { status: '404 Not Found' } }
      : { response: { status: '200 OK' }, resource: found }
  }),
})

/**
 * A server holding `storedResources`, its client layer, and the requests it
 * was sent: `<Type> <identifier tokens>` per search, `<Type> by name` per
 * name-stage search, and `read <urls>` per batch of reads.
 */
const inMemoryServer = (
  storedResources: readonly FhirResourceWithId[]
): { readonly layer: Layer.Layer<FhirR4ResourcesHttpApiClient>; readonly requests: string[] } => {
  const requests: string[] = []
  const storedWires = storedResources.map(wireOf)
  const httpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((request) => {
        const raw =
          request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
        const [, resourceType] = /\/(\w+)\/_search$/u.exec(request.url) ?? []
        const answer =
          resourceType === undefined
            ? (() => {
                const urls = batchUrlsOf(raw)
                requests.push(`read ${urls.join(', ')}`)
                return batchAnswer(storedWires, urls)
              })()
            : (() => {
                const form = new URLSearchParams(raw)
                requests.push(`${resourceType} ${form.get('identifier') ?? 'by name'}`)
                return searchAnswer(storedWires, resourceType, form)
              })()
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(answer), {
              status: 200,
              headers: { 'content-type': 'application/fhir+json' },
            })
          )
        )
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )
  return { layer: FhirR4ResourcesHttpApiClient.layer.pipe(Layer.provide(httpClient)), requests }
}

/** `effect` run against a server holding `storedResources`, and the requests it sent. */
const runAgainst = async <A, E>(
  effect: Effect.Effect<A, E, FhirR4ResourcesHttpApiClient>,
  storedResources: readonly FhirResourceWithId[]
): Promise<{ readonly result: A; readonly requests: readonly string[] }> => {
  const server = inMemoryServer(storedResources)
  const result = await Effect.runPromise(effect.pipe(Effect.provide(server.layer)))
  return { result, requests: server.requests }
}

/** A one-set decode of the test format holding `records` under their local keys, from {@link PICKED_FILE}. */
const decodedOf = (
  records: readonly (readonly [string, DetachedResource.Type])[]
): FormatDecode.Decoded<string> => ({
  format: 'test',
  files: [PICKED_FILE],
  fileSets: [
    {
      pickedFiles: [DecodedFileSet.unidentified(PICKED_FILE)],
      sectionedList: SectionedList.make([
        Section.make(
          'records',
          records.map(([localKey, resource]) => ({ localKey, resource, sourceUrl: Option.none() }))
        ),
      ]),
      notes: [],
    },
  ],
  unreadableFiles: [],
})

export {
  copyOf,
  decodedOf,
  derivedId,
  detached,
  NAMES,
  observationWire,
  PICKED_FILE,
  prescriptionWire,
  runAgainst,
  SOURCE,
  sourceFileFormat,
  stored,
  tyraWire,
}
