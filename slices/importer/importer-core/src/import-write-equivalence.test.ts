import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  FhirResourceSchema,
  type FhirResourceWithId,
  literalReferenceOf,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  type FormatDecode,
  ImportWrite,
  LinkChoiceSet,
  type PickedFile,
  resolvePlan,
  Section,
  SectionedList,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Either, Option, Order, Schema, TestContext } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { fileCopiesOf } from './file-copies-of.ts'
import { noStore } from './find-stored-match.ts'
import { importDecoded, type ImportingFormat } from './import-decoded.ts'
import { planImport } from './plan-import.ts'
import { planWrite } from './plan-write.ts'
import { formatRegistry } from './registry.ts'
import { resolveMentions } from './resolve-mentions.ts'
import { keysWithoutPatientOf } from './unlinked-mentions.ts'

/**
 * Holds the import plan's write to the review screen's: for a batch read onto
 * an empty store, every record saved as new, the plan writes what the review
 * screen's import (`importDecoded`, `resolveMentions` on its defaults,
 * `planWrite`'s `Included`) writes, a record two files bring written from the
 * last file's copy in both.
 *
 * The batch steers clear of where the two differ. It brings each Patient and
 * Practitioner once: the review screen's import writes such a record from its
 * first mention, where the plan writes its last decoded copy. And every
 * record names a Patient (the dispense through its prescription): the review
 * screen's import leaves out a record that names none, where the plan saves
 * it as new.
 */

const SOURCE = 'https://pharmacy.example/id'
const NAMES = 'https://pharmacy.example/practitioner-name'
const SERVER_BINARY = 'https://source.example/fhir/Binary/b-1'

const detached = (fields: object): DetachedResource.Type =>
  Either.getOrThrow(DetachedResource.decodeUnknownEither(FhirResourceSchema)(fields))

const tyra = detached({
  resourceType: 'Patient',
  identifier: [{ system: SOURCE, value: 'tyra' }],
  name: [{ family: 'Ashford', given: ['Tyra'] }],
  birthDate: '1990-01-02',
})

const tyraReference = { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } }

const prescription = detached({
  resourceType: 'MedicationRequest',
  identifier: [{ system: SOURCE, value: 'rx-1' }],
  status: 'active',
  intent: 'order',
  medicationCodeableConcept: { text: 'Metformin' },
  subject: tyraReference,
  requester: {
    type: 'Practitioner',
    identifier: { system: NAMES, value: 'Dr. Brown' },
    display: 'Dr. Brown',
  },
})

/**
 * The prescription as a later export gives it, renewed, naming its
 * prescriber with no display, so it implies no second Dr. Brown.
 */
const laterPrescription = detached({
  ...Schema.encodeSync(FhirResourceSchema)(prescription),
  authoredOn: '2026-07-01T00:00:00.000Z',
  requester: { type: 'Practitioner', identifier: { system: NAMES, value: 'Dr. Brown' } },
})

const fill = detached({
  resourceType: 'MedicationDispense',
  identifier: [{ system: SOURCE, value: 'fill-1' }],
  status: 'completed',
  medicationCodeableConcept: { text: 'Metformin' },
  authorizingPrescription: [
    { type: 'MedicationRequest', identifier: { system: SOURCE, value: 'rx-1' } },
  ],
})

const binary = detached({ resourceType: 'Binary', contentType: 'text/plain', data: 'aGk=' })

const document = detached({
  resourceType: 'DocumentReference',
  identifier: [{ system: SOURCE, value: 'doc-1' }],
  status: 'current',
  subject: tyraReference,
  content: [{ attachment: { contentType: 'text/plain', url: SERVER_BINARY } }],
})

const pickedFile = (index: number, fileName: string): PickedFile.Type => ({
  id: `${index}:${fileName}`,
  fileName,
  bytes: new TextEncoder().encode(fileName),
})

/** One file set read from `file`, its records in one section under their local keys. */
const fileSetOf = (
  file: PickedFile.Type,
  records: readonly (readonly [string, DetachedResource.Type, Option.Option<URL>])[]
): DecodedFileSet.Type => ({
  pickedFiles: [DecodedFileSet.unidentified(file)],
  sectionedList: SectionedList.make([
    Section.make(
      'records',
      records.map(([localKey, resource, sourceUrl]) => ({ localKey, resource, sourceUrl }))
    ),
  ]),
  notes: [],
})

const FIRST = pickedFile(0, 'first.har')
const SECOND = pickedFile(1, 'second.har')

/** Two HAR file sets: a pharmacy's records in the first, a later copy of its prescription in the second. */
const decoded: FormatDecode.Decoded<'har'> = {
  format: 'har',
  files: [FIRST, SECOND],
  fileSets: [
    fileSetOf(FIRST, [
      ['tyra', tyra, Option.none()],
      ['rx-1', prescription, Option.none()],
      ['fill-1', fill, Option.none()],
      ['doc-1', document, Option.none()],
      ['b-1', binary, Option.some(new URL(SERVER_BINARY))],
    ]),
    fileSetOf(SECOND, [['rx-1', laterPrescription, Option.none()]]),
  ],
  unreadableFiles: [],
}

/**
 * The HAR importer with a `linkSourceFile` filing each source file under the
 * Patient of its set, as DICOM's files its own, so the import stage's links
 * are held too.
 */
const importer: ImportingFormat = {
  ...formatRegistry.har,
  linkSourceFile: (sourceFile, adopted) => ({
    ...sourceFile,
    subject: Option.getOrNull(
      Option.map(
        Option.fromNullable(
          SectionedList.rows(adopted.sectionedList).find(
            ({ resource }) => resource.resourceType === 'Patient'
          )
        ),
        ({ resource }) => ({
          ...IdentifierAndReference.emptyReference,
          reference: literalReferenceOf(resource),
        })
      )
    ),
  }),
}

/** What the review screen's import writes: its `Included` resources. */
const reviewScreenWrite = (): Promise<readonly FhirResourceWithId[]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const group = yield* importDecoded(importer, decoded)
      const batch = yield* resolveMentions(
        { groups: { har: group }, unrecognizedFiles: [] },
        LinkChoiceSet.empty
      )
      const harGroup = batch.groups.har ?? group
      const keysWithoutPatient = keysWithoutPatientOf(
        batch.plan,
        'har',
        harGroup,
        StagedImport.initial()
      )
      return planWrite(
        batch,
        () => StagedImport.initial(),
        (kind) => (kind === 'har' ? keysWithoutPatient : new Set()),
        new Set()
      )
        .filter(({ disposition }) => disposition === 'Included')
        .map(({ resource }) => resource)
    }).pipe(Effect.provide(TestContext.TestContext))
  )

/** What the import plan writes onto an empty store, every suggestion taken. */
const importPlanWrite = async (): Promise<readonly FhirResourceWithId[]> => {
  const { copies } = await Effect.runPromise(fileCopiesOf(importer, decoded))
  const resolution = await Effect.runPromise(
    Effect.flatMap(planImport(copies, noStore), (plan) => resolvePlan(plan))
  )
  return ImportWrite.match(ImportWrite.of(resolution), {
    Ready: ({ resources }) => resources,
    Blocked: () => [],
  })
}

/** `resources` as JSON in `Type/id` order, each minted id read as `minted`. */
const comparable = (resources: readonly FhirResourceWithId[]): readonly string[] =>
  resources
    .toSorted(Order.mapInput(Order.string, literalReferenceOf))
    .map((resource) =>
      JSON.stringify(Schema.encodeSync(FhirResourceSchema)(resource)).replaceAll(
        /00000000-0000-4000-8000-\d{12}/gu,
        'minted'
      )
    )

describe('the import plan’s write, every record saved as new onto an empty store', () => {
  beforeEach(() => {
    let minted = 0
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      minted += 1
      return `00000000-0000-4000-8000-${String(minted).padStart(12, '0')}`
    })
    return () => vi.restoreAllMocks()
  })

  it('should write what the review screen’s import, its identity map and its write plan write', async () => {
    // Arrange / Act
    const reviewed = comparable(await reviewScreenWrite())
    const planned = comparable(await importPlanWrite())

    // Assert
    expect({ written: reviewed.length, planned }).toEqual({ written: 8, planned: reviewed })
  })
})
