import { DateTime, Effect, Either, Schema } from 'effect'
import { type DocumentReference, type FhirResource, FhirResourceSchema } from 'fhir-r4/resources'
import { harImporter } from 'har-importer-core'
import { PickedFile } from 'importer-fundamentals'
import { DataSet, type DataSetManifest } from 'synthetic-data-core'

import type { Fetch } from './data-set-read.ts'

/**
 * A small data set built the way a published one is: resources with a real
 * HAR source file, laid out and listed by `synthetic-data-core`'s
 * `DataSet.assemble`, served from an in-memory static host.
 */

/** Where the fixture data set is served. */
const DATA_SET_URL = 'https://data.example/synthetic/'

const AS_OF = DateTime.unsafeMake('2026-09-28T00:00:00.000Z')

/** The HAR both people's records were imported from: a family account's. */
const HAR_FILE_NAME = 'family.har'

// Re-wrapped through the ambient `Uint8Array`: jsdom's `TextEncoder` returns
// one from another realm, which the source file codec's schema rejects.
const HAR_BYTES = new Uint8Array(new TextEncoder().encode('{"log":{"version":"1.2","entries":[]}}'))

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** The HAR's source file, as the HAR importer mints it: its bytes inline as `data`. */
const mintHarSourceFile = (): Promise<DocumentReference.Type> =>
  Effect.runPromise(
    Schema.encode(PickedFile.FromDocumentReference)({
      id: `0:${HAR_FILE_NAME}`,
      fileName: HAR_FILE_NAME,
      bytes: HAR_BYTES,
    }).pipe(Effect.provideService(PickedFile.Format, harImporter.sourceFileFormat))
  )

/** A person's Patient and Observations, each stamped with the source file they were read from. */
const recordsOf = (
  patientId: string,
  observationIds: readonly string[],
  sourceFileId: string
): readonly FhirResource[] => {
  const meta = { source: `DocumentReference/${sourceFileId}` }
  return [
    decodeResource({ resourceType: 'Patient', id: patientId, meta }),
    ...observationIds.map((id) =>
      decodeResource({
        resourceType: 'Observation',
        id,
        meta,
        status: 'final',
        code: { text: 'Heart rate' },
        subject: { reference: `Patient/${patientId}` },
      })
    ),
  ]
}

/** The two people the fixture holds, in its order. */
const PEOPLE = [
  { key: 'person-a', displayName: 'Avery Example', summary: 'Two heart rate readings.' },
  { key: 'person-b', displayName: 'Blair Example', summary: 'One heart rate reading.' },
] as const satisfies readonly DataSetManifest.Person[]

/** The fixture: every file of the data set, and the source file as imported. */
interface DataSetFixture {
  readonly files: readonly DataSet.File[]
  readonly sourceFile: DocumentReference.Type
  /** Every resource as imported, by `<ResourceType>/<id>`. */
  readonly resourcesByLabel: ReadonlyMap<string, FhirResource>
}

/**
 * Two people sharing one HAR source file: Avery (a Patient and two
 * Observations) and Blair (a Patient and one Observation).
 */
const dataSetFixture = async (): Promise<DataSetFixture> => {
  const sourceFile = await mintHarSourceFile()
  const sourceFileId = sourceFile.id ?? ''
  const averyRecords = recordsOf('patient-a', ['obs-a1', 'obs-a2'], sourceFileId)
  const blairRecords = recordsOf('patient-b', ['obs-b1'], sourceFileId)
  const files = Either.getOrThrow(
    DataSet.assemble(AS_OF, 'abc1234', [
      { person: PEOPLE[0], resources: [sourceFile, ...averyRecords] },
      { person: PEOPLE[1], resources: [sourceFile, ...blairRecords] },
    ])
  )
  const resourcesByLabel = new Map(
    [sourceFile, ...averyRecords, ...blairRecords].map((resource) => [
      `${resource.resourceType}/${resource.id}`,
      resource,
    ])
  )
  return { files, sourceFile, resourcesByLabel }
}

/** A static host serving `files` at {@link DATA_SET_URL}, and the URLs it was asked for. */
interface StaticHost {
  readonly fetch: Fetch
  readonly requestedUrls: readonly string[]
}

/**
 * Serve `files` as a static host would; any other URL is a 404.
 *
 * @param replaced - Paths whose contents are replaced (`undefined` removes the file)
 */
const staticHostOf = (
  files: readonly DataSet.File[],
  replaced: ReadonlyMap<string, string | Uint8Array | undefined> = new Map()
): StaticHost => {
  const contentsByUrl = new Map(
    files.map(({ path, contents }) => [
      `${DATA_SET_URL}${path}`,
      replaced.has(path) ? replaced.get(path) : contents,
    ])
  )
  const requestedUrls: string[] = []
  const fetch: Fetch = (url) => {
    requestedUrls.push(url)
    const contents = contentsByUrl.get(url)
    return Promise.resolve(
      contents === undefined
        ? new Response('Not Found', { status: 404, statusText: 'Not Found' })
        : new Response(typeof contents === 'string' ? contents : new Uint8Array(contents))
    )
  }
  return { fetch, requestedUrls }
}

export { DATA_SET_URL, dataSetFixture, HAR_BYTES, PEOPLE, staticHostOf }
export type { DataSetFixture, StaticHost }
