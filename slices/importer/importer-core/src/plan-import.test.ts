import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  FhirResourceSchema,
  type FhirResourceWithId,
  literalReferenceOf,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  FileCopy,
  type FormatDecode,
  PickedFile,
  PlannedRecord,
  RecordReferences,
  Section,
  SectionedList,
  type StoredMatch,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Either, HashMap, Layer, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { sourceFileOf } from './import-decoded.ts'
import { fileCopiesOf, findStoredMatch, planImport } from './plan-import.ts'

/**
 * Covers the import plan's stage work against an in-memory server: a
 * format's decode read as copies, the one match of an import's records and
 * unresolved references, the derived-id reads, and the plan built on them.
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
const copyOf = (resource: DetachedResource.Type, localKey: string): FileCopy.Type => ({
  format: 'test',
  pickedFiles: [PICKED_FILE],
  reviewKey: `${PICKED_FILE.id}/${localKey}`,
  title: localKey,
  isImplied: false,
  resource,
  sourceUrl: Option.none(),
  derivedId: Option.map(DetachedResource.keyIdentifierOf(resource), ({ value }) =>
    derivedId(resource.resourceType, value)
  ),
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

/** A stored match's entries for `records`, in record order, as literal references, for a whole-value assertion. */
const summaryOf = (
  records: readonly FileCopy.RecordCopies[],
  storedMatch: StoredMatch.Type
): unknown => ({
  candidatesByRecord: records.map(({ key }) =>
    HashMap.get(storedMatch.candidatesByRecord, key).pipe(
      Option.map((candidates) =>
        candidates.map(({ resource, grade, by }) => [literalReferenceOf(resource), grade, by])
      )
    )
  ),
  storedUnderDerivedId: records.map(({ key }) =>
    HashMap.get(storedMatch.storedUnderDerivedIdByRecord, key).pipe(Option.map(literalReferenceOf))
  ),
  candidatesByUnresolvedReference: [
    ...HashMap.values(storedMatch.candidatesByUnresolvedReference),
  ].map((candidates) => candidates.map(({ resource }) => literalReferenceOf(resource))),
})

describe('findStoredMatch', () => {
  it('should match every record and unresolved reference in one batch of searches, then read only the derived ids nothing was found for', async () => {
    // Arrange
    const records = FileCopy.groupByRecord([
      copyOf(detached(tyraWire), 'tyra'),
      copyOf(detached(observationWire), 'a1c-1'),
      copyOf(detached(prescriptionWire), 'rx-1'),
    ])
    const storedResources = [
      stored({ ...tyraWire, id: 'p-1' }),
      stored({ ...observationWire, identifier: [], id: derivedId('Observation', 'a1c-1') }),
      stored({
        resourceType: 'Practitioner',
        id: 'pr-1',
        identifier: [{ system: NAMES, value: 'Dr. Brown' }],
      }),
    ]

    // Act
    const { result, requests } = await runAgainst(
      findStoredMatch(records, RecordReferences.of(records).unresolved),
      storedResources
    )

    // Assert
    expect({ requests: [...requests].toSorted(), match: summaryOf(records, result) }).toEqual({
      requests: [
        `MedicationRequest ${SOURCE}|rx-1`,
        `Observation ${SOURCE}|a1c-1`,
        `Patient ${SOURCE}|tyra`,
        `Practitioner ${NAMES}|Dr. Brown`,
        `read Observation/${derivedId('Observation', 'a1c-1')}, MedicationRequest/${derivedId('MedicationRequest', 'rx-1')}`,
      ],
      match: {
        candidatesByRecord: [
          Option.some([['Patient/p-1', 'certain', 'identifier']]),
          Option.some([]),
          Option.some([]),
        ],
        storedUnderDerivedId: [
          Option.none(),
          Option.some(`Observation/${derivedId('Observation', 'a1c-1')}`),
          Option.none(),
        ],
        candidatesByUnresolvedReference: [['Practitioner/pr-1']],
      },
    })
  })

  it('should send no read when every record with a derived id has a candidate found by identifier', async () => {
    // Arrange
    const records = FileCopy.groupByRecord([copyOf(detached(tyraWire), 'tyra')])

    // Act
    const { requests } = await runAgainst(findStoredMatch(records, []), [
      stored({ ...tyraWire, id: 'p-1' }),
    ])

    // Assert
    expect(requests).toEqual([`Patient ${SOURCE}|tyra`])
  })
})

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

describe('fileCopiesOf', () => {
  it('should read a file set as its source file, then its records, then the records they imply, all detached', async () => {
    // Arrange
    const decoded = decodedOf([
      ['tyra', detached(tyraWire)],
      ['rx-1', detached(prescriptionWire)],
    ])

    // Act
    const copies = await Effect.runPromise(fileCopiesOf({ sourceFileFormat }, decoded))

    // Assert
    expect(
      copies.map(({ reviewKey, resource, isImplied, derivedId: id }) => ({
        reviewKey,
        resourceType: resource.resourceType,
        id: resource.id,
        isImplied,
        hasDerivedId: Option.isSome(id),
      }))
    ).toEqual([
      {
        reviewKey: '0:a.test/source-file/a.test',
        resourceType: 'DocumentReference',
        id: null,
        isImplied: false,
        hasDerivedId: true,
      },
      {
        reviewKey: '0:a.test/tyra',
        resourceType: 'Patient',
        id: null,
        isImplied: false,
        hasDerivedId: true,
      },
      {
        reviewKey: '0:a.test/rx-1',
        resourceType: 'MedicationRequest',
        id: null,
        isImplied: false,
        hasDerivedId: true,
      },
      {
        reviewKey: `0:a.test/rx-1#implied:Practitioner|${NAMES}|Dr. Brown`,
        resourceType: 'Practitioner',
        id: null,
        isImplied: true,
        hasDerivedId: true,
      },
    ])
  })
})

describe('planImport', () => {
  it('should find a re-imported source file and record the same as existing under their derived ids', async () => {
    // Arrange
    const copies = await Effect.runPromise(
      fileCopiesOf({ sourceFileFormat }, decodedOf([['tyra', detached(tyraWire)]]))
    )
    const storedSourceFile = await Effect.runPromise(
      sourceFileOf(PICKED_FILE).pipe(Effect.provideService(PickedFile.Format, sourceFileFormat))
    )
    const storedTyra = stored({ ...tyraWire, identifier: [], id: derivedId('Patient', 'tyra') })

    // Act
    const { result } = await runAgainst(planImport(copies), [storedSourceFile, storedTyra])

    // Assert
    expect(
      result.records.map((planned) => ({
        reason: planned.suggestion.reason._tag,
        label: PlannedRecord.labelOf(planned),
      }))
    ).toEqual([
      { reason: 'IdentifierMatchSameAsExisting', label: 'LinkToExisting' },
      { reason: 'IdentifierMatchSameAsExisting', label: 'LinkToExisting' },
    ])
  })
})
