import {
  dicomStudyArb,
  withElementsSpliced,
  writeDicom,
  writeStudy,
  type StudyFixture,
  type DicomTagMap,
} from '@wildflowerhealthio/dicom/test-helpers'
import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  DocumentReference,
  type FhirResourceWithId,
  type ImagingStudy,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  type FileImporter,
  DecodedFile,
  type FormatDecode,
  type PickedFile,
  Referent,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import type { Array as Arr } from 'effect'
import { Effect, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { DicomHeader } from '@wildflowerhealthio/dicom'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  decodeStudy,
  linkToPatientAndStudy,
  sopInstanceIdentifier,
  studyGroupKey,
  studyKey,
} from './decode.ts'
import { dicomImporter } from './dicom-importer.ts'
import { type DicomSettings } from './settings.ts'
import { DICOM_PRACTITIONER_NAME_SYSTEM, DICOM_SYSTEM } from './source-system.ts'

/**
 * A fixed zone rather than the default, whose `timeZone` is the runtime's own:
 * an assertion on a resolved `started` has to name the zone it was resolved
 * against or it passes only on the machine that wrote it.
 */
const defaultDicomSettings: DicomSettings = { timeZone: 'America/Toronto' }

/**
 * A stored source file with the given id — the shape the import stage hands
 * `linkToPatientAndStudy`. Only its `id` matters here.
 */
const sourceFileWithId = (id: string): PickedFile.SourceFile =>
  Schema.decodeSync(withMandatoryId(DocumentReference.Schema))({
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    content: [{ attachment: { contentType: 'application/dicom' } }],
  })

/**
 * One file of a study — what the decode function hands this decode once it has
 * grouped the pick. The header is parsed by `decodeStudy` itself, so nothing
 * is passed alongside the bytes.
 */
const studyFile = (
  tags: DicomTagMap,
  { fileName = 'sample.dcm', index = 0 } = {}
): PickedFile.Type => ({
  id: `${index}:${fileName}`,
  fileName,
  bytes: writeDicom(tags),
})

const SAMPLE_TAGS: DicomTagMap = {
  StudyInstanceUID: '1.2.3.4.5',
  SeriesInstanceUID: '1.2.3.4.5.1',
  SOPInstanceUID: '1.2.3.4.5.1.1',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
  PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  PatientID: 'P001',
  Modality: 'CT',
  StudyDescription: 'Chest CT',
  StudyDate: '20240315',
  StudyTime: '143022',
  AccessionNumber: 'ACC001',
}

const sample = (overrides: DicomTagMap = {}): Arr.NonEmptyReadonlyArray<PickedFile.Type> => [
  studyFile({ ...SAMPLE_TAGS, ...overrides }),
]

/** A decode's records adopted as the import stage adopts them. */
const adoptedOf = (
  decoded: Pick<DecodedFileSet.Type, 'sections' | 'notes'>
): DecodedFile.DecodedFile => Either.getOrThrow(DecodedFileSet.adopt(decoded))

describe('decodeStudy', () => {
  it('resolves ImagingStudy.started against the settings time zone', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    const study = adoptedOf(result).sections[0].resources.find(
      (r) => r.key === 'imaging-study'
    )?.resource
    expect(study?.resourceType).toBe('ImagingStudy')
    if (study?.resourceType !== 'ImagingStudy') return
    // StudyTime 14:30:22 in Toronto on Mar 15 is EDT (UTC-4).
    expect(study.started).toBe('2024-03-15T18:30:22.000Z')
  })

  it('reads the same file as a different instant under a different zone', async () => {
    const startedIn = async (timeZone: string): Promise<string | null | undefined> => {
      const result = await Effect.runPromise(decodeStudy(sample(), { timeZone }))
      const study = adoptedOf(result).sections[0].resources.find(
        (r) => r.key === 'imaging-study'
      )?.resource
      return study?.resourceType === 'ImagingStudy' ? study.started : undefined
    }
    expect(await startedIn('America/Toronto')).not.toBe(await startedIn('America/Vancouver'))
  })

  it('yields one section with Patient, ServiceRequest, ImagingStudy', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    expect(result.sections).toHaveLength(1)
    const keys = adoptedOf(result).sections[0].resources.map((r) => r.key)
    expect(keys).toEqual(['patient', 'service-request', 'imaging-study'])
  })

  it("identifies each picked file as its SOP Instance UID, in FHIR's OID convention", async () => {
    const pickedFiles = sample()
    const result = await Effect.runPromise(decodeStudy(pickedFiles, defaultDicomSettings))
    const [identified] = result.pickedFiles ?? []
    expect(identified?.pickedFile).toBe(pickedFiles[0])
    const identifier = Option.getOrUndefined(identified?.identifiedAs ?? Option.none())
    expect(identifier?.system?.href).toBe('urn:ietf:rfc:3986')
    expect(identifier?.value).toBe('urn:oid:1.2.3.4.5.1.1')
    expect(identifier).toEqual(sopInstanceIdentifier('1.2.3.4.5.1.1'))
  })

  it('names no file on an ImagingStudy instance', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    const study = adoptedOf(result).sections[0].resources.find(
      (r) => r.key === 'imaging-study'
    )?.resource
    if (study?.resourceType !== 'ImagingStudy') throw new Error('expected ImagingStudy')
    expect(study.series[0].instance[0].extension).toEqual([])
  })

  it('writes each record detached, keyed in the DICOM system', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    const [section] = result.sections
    if (section === undefined) throw expect.fail('expected a section')
    for (const { resource } of section.entries) {
      expect(resource.id).toBeNull()
      const key = DetachedResource.keyOf(resource)
      expect(Option.map(key, ({ system }) => system)).toEqual(Option.some(DICOM_SYSTEM))
    }
  })

  it('section title includes modality, description, and date', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    expect(result.sections[0].title).toBe('CT Chest CT · 2024-03-15')
  })

  it('notes no ServiceRequest when AccessionNumber is absent', async () => {
    const result = await Effect.runPromise(
      decodeStudy(sample({ AccessionNumber: undefined }), defaultDicomSettings)
    )
    expect(result.notes.some((n) => n.includes('AccessionNumber'))).toBe(true)
    const keys = adoptedOf(result).sections[0].resources.map((r) => r.key)
    expect(keys).not.toContain('service-request')
  })

  it('yields zero sections and a note when no patient identity', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ PatientID: undefined, PatientName: undefined, AccessionNumber: undefined }),
        defaultDicomSettings
      )
    )
    expect(result.sections).toEqual([])
    expect(result.notes.some((n) => n.includes('patient identity'))).toBe(true)
  })

  it('treats a delimiters-only PatientName as no patient identity', async () => {
    // What a writer emits for an anonymized name. It is not a name with empty
    // parts: synthesizing one would write `name: [{ text: '' }]` (FHIR `string`
    // forbids an empty value) and derive the same Patient id for every such
    // file, collapsing unrelated studies onto one patient.
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ PatientID: undefined, PatientName: { family: '', given: '', text: '^^^' } }),
        defaultDicomSettings
      )
    )
    expect(result.sections).toEqual([])
    expect(result.notes.some((n) => n.includes('patient identity'))).toBe(true)
  })

  it('resource keys are stable across the empty settings', async () => {
    const keysOf = async (): Promise<readonly string[]> => {
      const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
      return adoptedOf(result).sections.flatMap((s) => s.resources.map((r) => r.key))
    }
    expect(await keysOf()).toEqual(await keysOf())
  })

  it("implies the referring physician's Practitioner, named by the PN, and requests the study of it", async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ ReferringPhysicianName: { family: 'Smith', given: 'Jane', text: 'Smith Jane' } }),
        defaultDicomSettings
      )
    )

    const resources = DecodedFile.resources(adoptedOf(result)).map(({ resource }) => resource)
    const physician = resources.find((resource) => resource.resourceType === 'Practitioner')
    const request = resources.find((resource) => resource.resourceType === 'ServiceRequest')

    expect(
      physician?.resourceType === 'Practitioner'
        ? {
            identifier: physician.identifier.map(({ system, value }) => [system?.href, value]),
            name: physician.name.map(({ text }) => text),
          }
        : physician
    ).toEqual({
      identifier: [[DICOM_PRACTITIONER_NAME_SYSTEM, 'Jane Smith']],
      name: ['Jane Smith'],
    })
    expect(
      request?.resourceType === 'ServiceRequest' ? request.requester?.reference : request
    ).toBe(`Practitioner/${physician?.id}`)
    const referents = Effect.runSync(Referent.discover([adoptedOf(result)]))
    expect(
      referents.map(({ logicalReference }) => [
        logicalReference.resourceType,
        logicalReference.identifier[0].system.href,
      ])
    ).toEqual([
      ['Practitioner', DICOM_PRACTITIONER_NAME_SYSTEM],
      ['Patient', DICOM_SYSTEM],
    ])
  })

  describe('a study spread across files', () => {
    const twoFiles: Arr.NonEmptyReadonlyArray<PickedFile.Type> = [
      studyFile(
        { ...SAMPLE_TAGS, SeriesInstanceUID: '1.2.3.4.5.2', SeriesNumber: 2, SOPInstanceUID: 'I2' },
        { fileName: 'b.dcm', index: 0 }
      ),
      studyFile(
        { ...SAMPLE_TAGS, SeriesInstanceUID: '1.2.3.4.5.1', SeriesNumber: 1, SOPInstanceUID: 'I1' },
        { fileName: 'a.dcm', index: 1 }
      ),
    ]

    it('is still one section with the same three keys', async () => {
      const result = await Effect.runPromise(decodeStudy(twoFiles, defaultDicomSettings))
      expect(result.sections).toHaveLength(1)
      expect(adoptedOf(result).sections[0].resources.map((r) => r.key)).toEqual([
        'patient',
        'service-request',
        'imaging-study',
      ])
    })

    it('notes what each file contributed, in study order', async () => {
      const result = await Effect.runPromise(decodeStudy(twoFiles, defaultDicomSettings))
      expect(result.notes).toEqual([
        'a.dcm: series 1, instance I1.',
        'b.dcm: series 2, instance I2.',
      ])
    })

    it('notes an AccessionNumber the files disagree on, and does not merge them', async () => {
      const conflicting: Arr.NonEmptyReadonlyArray<PickedFile.Type> = [
        twoFiles[0],
        studyFile(
          {
            ...SAMPLE_TAGS,
            SeriesInstanceUID: '1.2.3.4.5.1',
            SeriesNumber: 1,
            SOPInstanceUID: 'I1',
            AccessionNumber: 'ACC002',
          },
          { fileName: 'a.dcm', index: 1 }
        ),
      ]
      const result = await Effect.runPromise(decodeStudy(conflicting, defaultDicomSettings))
      expect(result.notes[0]).toContain('disagree on AccessionNumber')
      const request = adoptedOf(result).sections[0].resources.find(
        (r) => r.key === 'service-request'
      )?.resource
      if (request?.resourceType !== 'ServiceRequest') throw new Error('expected a ServiceRequest')
      // One request, built from the first accession in *study* order — a.dcm
      // is series 1 — with the other nowhere on it: the two are not merged.
      const values = request.identifier.map((one) => one.value)
      expect(values).toContain('ACC002')
      expect(values).not.toContain('ACC001')
    })

    it('says nothing per file when the study is one file', async () => {
      const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
      expect(result.notes).toEqual([])
    })
  })
})

describe('sectionTitle', () => {
  it('is the modality alone when nothing else is stated', async () => {
    // Modality is required of every header, so a study always names at least
    // that — there is no titleless study to fall back for.
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ StudyDescription: undefined, StudyDate: undefined, StudyTime: undefined }),
        defaultDicomSettings
      )
    )
    expect(result.sections[0].title).toBe('CT')
  })

  it('includes modality and date when available', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ Modality: 'MR', StudyDescription: undefined, StudyDate: '20240101' }),
        defaultDicomSettings
      )
    )
    expect(result.sections[0].title).toBe('MR · 2024-01-01')
  })

  it('reads the retired YYYY.MM.DD date spelling', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ Modality: 'MR', StudyDescription: undefined, StudyDate: '2024.01.01' }),
        defaultDicomSettings
      )
    )
    expect(result.sections[0].title).toBe('MR · 2024-01-01')
  })

  it('leaves out a date that names no real day', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({ Modality: 'MR', StudyDescription: undefined, StudyDate: '20240230' }),
        defaultDicomSettings
      )
    )
    expect(result.sections[0].title).toBe('MR')
  })
})

/**
 * The batch decode as the importer exposes it, its file sets apart. The
 * import stage over it, source files and all, is `importer-core`'s to test.
 */
const decode = dicomImporter.decode

const SETTINGS: DicomSettings = { timeZone: 'America/Toronto' }

/** The picks with the ids `readBatch` stamps them with, in pick order. */
const asBatch = (files: readonly PickedFile.NamedBytes[]): readonly PickedFile.Type[] =>
  files.map((file, index) => ({ ...file, id: `${index}:${file.fileName}` }))

const run = (files: readonly PickedFile.NamedBytes[]): Promise<FormatDecode.Decoded<string>> =>
  Effect.runPromise(decode(asBatch(files), SETTINGS))

const resourcesOf = (result: FormatDecode.Decoded<string>): readonly DecodedFile.Resource[] =>
  result.fileSets.flatMap((fileSet) => DecodedFile.resources(adoptedOf(fileSet)))

/** Every decoded resource of one type, across every section. */
const of = <K extends FhirResourceWithId['resourceType']>(
  result: FormatDecode.Decoded<string>,
  resourceType: K
): readonly Extract<FhirResourceWithId, { readonly resourceType: K }>[] =>
  resourcesOf(result)
    .map((entry) => entry.resource)
    .filter(
      (resource): resource is Extract<FhirResourceWithId, { readonly resourceType: K }> =>
        resource.resourceType === resourceType
    )

const studiesOf = (result: FormatDecode.Decoded<string>): readonly ImagingStudy.Type[] =>
  of(result, 'ImagingStudy')

/** The sections a study was decoded into. */
const studySections = (result: FormatDecode.Decoded<string>): readonly DecodedFile.Section[] =>
  result.fileSets
    .flatMap((fileSet) => adoptedOf(fileSet).sections)
    .filter((section) => section.resources.some((one) => one.key.endsWith('imaging-study')))

/** Each file set's source file as `linkToPatientAndStudy` links it, minted under `doc`. */
const linkedSourceFilesOf = (
  result: FormatDecode.Decoded<string>
): readonly PickedFile.SourceFile[] =>
  result.fileSets.map((fileSet) =>
    linkToPatientAndStudy(sourceFileWithId('doc'), adoptedOf(fileSet))
  )

/** A study fixture's files, ready to pick. */
const picksOf = (fixture: StudyFixture): readonly PickedFile.NamedBytes[] => writeStudy(fixture)

const TAGS = {
  StudyInstanceUID: '1.2.3.4.5',
  PatientID: 'P001',
  PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  Modality: 'CT',
  SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
} as const

/** One file of the canonical study, varied by whichever tags a case cares about. */
const file = (fileName: string, overrides: DicomTagMap = {}): PickedFile.NamedBytes => ({
  fileName,
  bytes: writeDicom({
    ...TAGS,
    SeriesInstanceUID: '1.2.3.4.5.1',
    SOPInstanceUID: `1.2.3.4.5.1.${fileName}`,
    ...overrides,
  }),
})

describe('the DICOM batch decode', () => {
  it('reads N files of one study as one ImagingStudy', async () => {
    const result = await run([
      file('1', { SeriesInstanceUID: '1.2.3.4.5.1', SeriesNumber: 1, SOPInstanceUID: 'I1' }),
      file('2', { SeriesInstanceUID: '1.2.3.4.5.1', SeriesNumber: 1, SOPInstanceUID: 'I2' }),
      file('3', { SeriesInstanceUID: '1.2.3.4.5.2', SeriesNumber: 2, SOPInstanceUID: 'I3' }),
    ])
    const [study, ...rest] = studiesOf(result)
    expect(rest).toEqual([])
    expect(study.numberOfSeries).toBe(2)
    expect(study.numberOfInstances).toBe(3)
    expect(of(result, 'Patient')).toHaveLength(1)
    expect(studySections(result)).toHaveLength(1)
  })

  it('links each source file to the patient and the study its set decoded to', async () => {
    const result = await run([
      file('1', { SOPInstanceUID: 'I1', InstanceNumber: 1 }),
      file('2', { SOPInstanceUID: 'I2', InstanceNumber: 2 }),
    ])
    const [study] = studiesOf(result)
    const [patient] = of(result, 'Patient')
    for (const sourceFile of linkedSourceFilesOf(result)) {
      expect(sourceFile.subject?.reference).toBe(`Patient/${patient.id}`)
      expect(sourceFile.context?.related.map((one) => one.reference)).toEqual([
        `ImagingStudy/${study.id}`,
      ])
    }
  })

  it('splits a pick spanning two studies into two file sets', async () => {
    const result = await run([
      file('1', { StudyInstanceUID: '1.2.3.4.5', SOPInstanceUID: 'I1' }),
      file('2', { StudyInstanceUID: '9.9.9.9.9', SOPInstanceUID: 'I2' }),
    ])
    const studies = studiesOf(result)
    expect(studies).toHaveLength(2)
    expect(new Set(studies.map((one) => one.id)).size).toBe(2)
    expect(studySections(result)).toHaveLength(2)
  })

  it('splits one study whose files name different patients', async () => {
    const result = await run([
      file('1', { PatientID: 'P001', SOPInstanceUID: 'I1' }),
      file('2', { PatientID: 'P002', SOPInstanceUID: 'I2' }),
    ])
    // Two reviewable file sets under two patients, never one silently merged
    // study — and two ids, so storing the second never overwrites the first.
    const studies = studiesOf(result)
    expect(studies).toHaveLength(2)
    expect(new Set(of(result, 'Patient').map((one) => one.id)).size).toBe(2)
    expect(new Set(studies.map((one) => one.id)).size).toBe(2)
    expect(new Set(studies.map((one) => one.subject.reference)).size).toBe(2)

    const studyById = new Map(studies.map((one) => [`ImagingStudy/${one.id}`, one]))
    for (const sourceFile of linkedSourceFilesOf(result)) {
      const [related] = sourceFile.context?.related.map((one) => one.reference) ?? []
      expect(studyById.get(related ?? '')?.subject.reference).toBe(sourceFile.subject?.reference)
    }
  })

  it('gives each patient of one shared accession their own ServiceRequest', async () => {
    const result = await run([
      file('1', { PatientID: 'P001', SOPInstanceUID: 'I1', AccessionNumber: 'ACC001' }),
      file('2', { PatientID: 'P002', SOPInstanceUID: 'I2', AccessionNumber: 'ACC001' }),
    ])
    const requests = of(result, 'ServiceRequest')
    expect(requests).toHaveLength(2)
    expect(new Set(requests.map((one) => one.id)).size).toBe(2)

    const requestById = new Map(requests.map((one) => [`ServiceRequest/${one.id}`, one]))
    for (const study of studiesOf(result)) {
      const [basedOn] = study.basedOn.map((one) => one.reference)
      expect(requestById.get(basedOn ?? '')?.subject.reference).toBe(study.subject.reference)
    }
  })

  it('reports an unparsable file on its own, leaving the study readable', async () => {
    const result = await run([
      file('1', { SOPInstanceUID: 'I1' }),
      { fileName: 'junk.dcm', bytes: new Uint8Array([0x00, 0x01, 0x02]) },
    ])
    expect(result.unreadableFiles.map((one) => one.title)).toEqual(['junk.dcm'])
    expect(studiesOf(result)).toHaveLength(1)
  })

  it('reports a file in ISO 2022 code extensions on its own, leaving the study readable', async () => {
    // `Yamada^Tarou=` then `山田^太郎` in ISO 2022 IR 87 — PS3.5 H.3.1.
    const yamada = withElementsSpliced(
      writeDicom({
        ...TAGS,
        PatientName: undefined,
        SpecificCharacterSet: '\\ISO 2022 IR 87',
        SeriesInstanceUID: '1.2.3.4.5.1',
        SOPInstanceUID: 'I2',
      }),
      [
        {
          tag: 0x0010_0010,
          vr: 'PN',
          value: new Uint8Array([
            ...new TextEncoder().encode('Yamada^Tarou='),
            0x1b,
            0x24,
            0x42,
            0x3b,
            0x33,
            0x45,
            0x44,
            0x1b,
            0x28,
            0x42,
            0x5e,
            0x1b,
            0x24,
            0x42,
            0x42,
            0x40,
            0x4f,
            0x3a,
            0x1b,
            0x28,
            0x42,
          ]),
        },
      ]
    )
    const result = await run([
      file('1', { SOPInstanceUID: 'I1' }),
      { fileName: 'yamada.dcm', bytes: yamada },
    ])
    expect(result.unreadableFiles.map((one) => one.title)).toEqual(['yamada.dcm'])
    expect(result.unreadableFiles[0]?.error.message).toContain('ISO 2022')
    expect(studiesOf(result)).toHaveLength(1)
  })

  it('fails every file rather than guessing when the time zone is not a zone', async () => {
    const files = [file('1', { SOPInstanceUID: 'I1' }), file('2', { SOPInstanceUID: 'I2' })]
    const result = await Effect.runPromise(decode(asBatch(files), { timeZone: 'Mars/Olympus' }))
    expect(result.unreadableFiles).toHaveLength(2)
    expect(result.fileSets).toEqual([])
  })

  describe('over a generated study', () => {
    const decodedStudy = async (
      fixture: StudyFixture,
      files: readonly PickedFile.NamedBytes[]
    ): Promise<ImagingStudy.Type> => {
      const result = await run(files)
      expect(result.unreadableFiles).toEqual([])
      const [study, ...rest] = studiesOf(result)
      expect(rest).toEqual([])
      expect(study.identifier.map((one) => one.value)).toContain(
        `urn:oid:${fixture.studyInstanceUid}`
      )
      return study
    }

    it('has one instance per file, one series per distinct SeriesInstanceUID', async () => {
      await fc.assert(
        fc.asyncProperty(dicomStudyArb(), async (fixture) => {
          const study = await decodedStudy(fixture, picksOf(fixture))
          expect(study.numberOfInstances).toBe(fixture.files.length)
          expect(study.numberOfSeries).toBe(fixture.seriesUidsInOrder.length)
          expect(study.series.flatMap((one) => one.instance)).toHaveLength(fixture.files.length)
        }),
        { numRuns: numRunsFor({ base: 20 }) }
      )
    })

    it('orders series and instances by their numbers, whatever order the files came in', async () => {
      await fc.assert(
        fc.asyncProperty(dicomStudyArb(), async (fixture) => {
          const study = await decodedStudy(fixture, picksOf(fixture).toReversed())
          expect(study.series.map((one) => one.uid)).toEqual(fixture.seriesUidsInOrder)
          expect(study.series.flatMap((one) => one.instance.map((each) => each.uid))).toEqual(
            fixture.instanceUidsInOrder
          )
        }),
        { numRuns: numRunsFor({ base: 20 }) }
      )
    })

    it('yields identical resources for any file order (property)', async () => {
      await fc.assert(
        fc.asyncProperty(dicomStudyArb(), async (fixture) => {
          const files = picksOf(fixture)
          const forward = await run(files)
          const reversed = await run(files.toReversed())
          const bodies = (result: FormatDecode.Decoded<string>): readonly unknown[] =>
            resourcesOf(result)
              .map((entry) => entry.resource)
              .toSorted((left, right) => left.id.localeCompare(right.id))
          expect(bodies(reversed)).toEqual(bodies(forward))
        }),
        { numRuns: numRunsFor({ base: 20 }) }
      )
    })
  })
})

describe('the DICOM importer', () => {
  it('exposes the same importer shape every other format does', () => {
    // The decode is the format's own, built from its `groupBy`: what a
    // consumer holds is the same `FileImporter.Type` every format exposes.
    const importer: FileImporter.Type<DicomSettings, 'dicom'> = dicomImporter
    expect(importer.format).toBe('dicom')
  })
})

describe('studyGroupKey', () => {
  /** The key a picked file states, or the failure that keeps it out of every set. */
  const keyOf = (picked: PickedFile.NamedBytes): Either.Either<string, unknown> =>
    studyGroupKey({ ...picked, id: `0:${picked.fileName}` })

  it('gives the files of one study one key, whatever order they were picked in', () => {
    const keys = [
      file('2', { SOPInstanceUID: 'I2', InstanceNumber: 2 }),
      file('1', { SOPInstanceUID: 'I1', InstanceNumber: 1 }),
    ].map(keyOf)
    expect(keys.every(Either.isRight)).toBe(true)
    expect(new Set(keys.map((key) => (Either.isRight(key) ? key.right : null))).size).toBe(1)
  })

  it('keys a study by its UID and its patient, so a differing patient splits it', () => {
    const keys = [
      file('1', { PatientID: 'P001', SOPInstanceUID: 'I1' }),
      file('2', { PatientID: 'P002', SOPInstanceUID: 'I2' }),
    ].map(keyOf)
    expect(new Set(keys.map((key) => (Either.isRight(key) ? key.right : null))).size).toBe(2)
  })

  it('leaves a file whose header does not parse out of every set', () => {
    const outcome = keyOf({ fileName: 'junk.dcm', bytes: new Uint8Array([0, 1, 2]) })
    expect(Either.isLeft(outcome)).toBe(true)
  })

  it('property: every file of a generated study states the same key', () => {
    fc.assert(
      fc.property(dicomStudyArb(), (fixture) => {
        const keys = picksOf(fixture).map(keyOf)
        expect(keys.every(Either.isRight)).toBe(true)
        const values = keys.map((key) => (Either.isRight(key) ? key.right : null))
        expect(new Set(values).size).toBe(1)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})

describe('studyKey', () => {
  it('names the study UID and the patient it is filed under', () => {
    const parsed = DicomHeader.tryFromDicomFile(writeDicom(SAMPLE_TAGS))
    expect(Either.isRight(parsed)).toBe(true)
    if (!Either.isRight(parsed)) return
    expect(studyKey(parsed.right)).toContain(SAMPLE_TAGS.StudyInstanceUID ?? '')
    expect(studyKey(parsed.right)).not.toBe(parsed.right.studyInstanceUid)
  })
})
