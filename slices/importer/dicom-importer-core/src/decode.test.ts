import {
  dicomStudyArb,
  writeDicom,
  writeStudy,
  type StudyFixture,
  type DicomTagMap,
} from 'dicom/test-helpers'
import type { Array as Arr } from 'effect'
import { Effect, Either } from 'effect'
import * as fc from 'fast-check'
import type { DocumentReference, FhirResource, ImagingStudy } from 'fhir-r4/resources'
import {
  type FileImporter,
  DecodedFile,
  type FormatDecode,
  PickedFile,
  SourceFile,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { DicomHeader } from 'dicom'
import { decodeStudy, partitionStudies, studyKey, type StudyMember } from './decode.ts'
import { dicomImporter } from './dicom-importer.ts'
import { type DicomSettings } from './settings.ts'

/**
 * A fixed zone rather than the default, whose `timeZone` is the runtime's own:
 * an assertion on a resolved `started` has to name the zone it was resolved
 * against or it passes only on the machine that wrote it.
 */
const defaultDicomSettings: DicomSettings = { timeZone: 'America/Toronto' }

/**
 * One file of a study, parsed — what the decode function hands this decode
 * once it has partitioned the pick and minted the archives.
 */
const studyFile = (
  tags: DicomTagMap,
  { fileName = 'sample.dcm', sourceFileId = 'doc-1', index = 0 } = {}
): StudyMember => {
  const bytes = writeDicom(tags)
  const parsed = DicomHeader.tryFromDicomFile(bytes)
  if (Either.isLeft(parsed)) throw new Error(parsed.left.reason)
  return {
    file: { fileName, bytes, source: PickedFile.Source.local },
    index,
    header: parsed.right,
    sourceFile: SourceFile.makeReference(sourceFileId),
  }
}

const SAMPLE_TAGS: DicomTagMap = {
  StudyInstanceUID: '1.2.3.4.5',
  SeriesInstanceUID: '1.2.3.4.5.1',
  SOPInstanceUID: '1.2.3.4.5.1.1',
  PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  PatientID: 'P001',
  Modality: 'CT',
  StudyDescription: 'Chest CT',
  StudyDate: '20240315',
  StudyTime: '143022',
  AccessionNumber: 'ACC001',
}

const sample = (overrides: DicomTagMap = {}): Arr.NonEmptyReadonlyArray<StudyMember> => [
  studyFile({ ...SAMPLE_TAGS, ...overrides }),
]

describe('decodeStudy', () => {
  it('resolves ImagingStudy.started against the settings time zone', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    const study = result.sections[0].resources.find((r) => r.key === 'imaging-study')?.resource
    expect(study?.resourceType).toBe('ImagingStudy')
    if (study?.resourceType !== 'ImagingStudy') return
    // StudyTime 14:30:22 in Toronto on Mar 15 is EDT (UTC-4).
    expect(study.started).toBe('2024-03-15T18:30:22.000Z')
  })

  it('reads the same file as a different instant under a different zone', async () => {
    const startedIn = async (timeZone: string): Promise<string | null | undefined> => {
      const result = await Effect.runPromise(decodeStudy(sample(), { timeZone }))
      const study = result.sections[0].resources.find((r) => r.key === 'imaging-study')?.resource
      return study?.resourceType === 'ImagingStudy' ? study.started : undefined
    }
    expect(await startedIn('America/Toronto')).not.toBe(await startedIn('America/Vancouver'))
  })

  it('yields one section with Patient, ServiceRequest, ImagingStudy', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))
    expect(result.sections).toHaveLength(1)
    const keys = result.sections[0].resources.map((r) => r.key)
    expect(keys).toEqual(['patient', 'service-request', 'imaging-study'])
  })

  it('ImagingStudy instance carries its own file id as its gridfsFileId', async () => {
    const result = await Effect.runPromise(decodeStudy(sample(), defaultDicomSettings))

    const studyEntry = result.sections[0].resources.find((r) => r.key === 'imaging-study')
    const study = studyEntry?.resource
    if (study?.resourceType !== 'ImagingStudy') throw new Error('expected ImagingStudy')
    const instance = study.series[0].instance[0]
    expect(instance.extension).toEqual([
      expect.objectContaining({ url: 'gridfsFileId', valueString: 'doc-1' }),
    ])
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
    const keys = result.sections[0].resources.map((r) => r.key)
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
      return result.sections.flatMap((s) => s.resources.map((r) => r.key))
    }
    expect(await keysOf()).toEqual(await keysOf())
  })

  describe('a study spread across files', () => {
    const twoFiles: Arr.NonEmptyReadonlyArray<StudyMember> = [
      studyFile(
        { ...SAMPLE_TAGS, SeriesInstanceUID: '1.2.3.4.5.2', SeriesNumber: 2, SOPInstanceUID: 'I2' },
        { fileName: 'b.dcm', sourceFileId: 'doc-b', index: 0 }
      ),
      studyFile(
        { ...SAMPLE_TAGS, SeriesInstanceUID: '1.2.3.4.5.1', SeriesNumber: 1, SOPInstanceUID: 'I1' },
        { fileName: 'a.dcm', sourceFileId: 'doc-a', index: 1 }
      ),
    ]

    it('is still one section with the same three keys', async () => {
      const result = await Effect.runPromise(decodeStudy(twoFiles, defaultDicomSettings))
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0].resources.map((r) => r.key)).toEqual([
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
      const conflicting: Arr.NonEmptyReadonlyArray<StudyMember> = [
        twoFiles[0],
        studyFile(
          {
            ...SAMPLE_TAGS,
            SeriesInstanceUID: '1.2.3.4.5.1',
            SeriesNumber: 1,
            SOPInstanceUID: 'I1',
            AccessionNumber: 'ACC002',
          },
          { fileName: 'a.dcm', sourceFileId: 'doc-a', index: 1 }
        ),
      ]
      const result = await Effect.runPromise(decodeStudy(conflicting, defaultDicomSettings))
      expect(result.notes[0]).toContain('disagree on AccessionNumber')
      const request = result.sections[0].resources.find(
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
  it('falls back to "DICOM study" when modality and description are absent', async () => {
    const result = await Effect.runPromise(
      decodeStudy(
        sample({
          Modality: undefined,
          StudyDescription: undefined,
          StudyDate: undefined,
          StudyTime: undefined,
        }),
        defaultDicomSettings
      )
    )
    expect(result.sections[0].title).toBe('DICOM study')
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
})

/**
 * The batch decode as the importer exposes it: `DecodeFunction.make` is what
 * provides the source-file context, and the archives it mints under the
 * format's real coding constants are half of what these tests are about.
 */
const decode = dicomImporter.decode

const SETTINGS: DicomSettings = { timeZone: 'America/Toronto' }

const pick = (file: {
  readonly fileName: string
  readonly bytes: Uint8Array
}): PickedFile.Type => ({
  ...file,
  source: PickedFile.Source.local,
})

const run = (files: readonly PickedFile.Type[]): Promise<FormatDecode.Result<string>> =>
  Effect.runPromise(decode(files, SETTINGS))

const resourcesOf = (result: FormatDecode.Result<string>): readonly DecodedFile.Resource[] =>
  DecodedFile.resources(result.decoded)

/** Every decoded resource of one type, across every section. */
const of = <K extends FhirResource['resourceType']>(
  result: FormatDecode.Result<string>,
  resourceType: K
): readonly Extract<FhirResource, { readonly resourceType: K }>[] =>
  resourcesOf(result)
    .map((entry) => entry.resource)
    .filter(
      (resource): resource is Extract<FhirResource, { readonly resourceType: K }> =>
        resource.resourceType === resourceType
    )

const studiesOf = (result: FormatDecode.Result<string>): readonly ImagingStudy.Type[] =>
  of(result, 'ImagingStudy')

const archivesOf = (result: FormatDecode.Result<string>): readonly DocumentReference.Type[] =>
  of(result, 'DocumentReference')

/** The sections a study was decoded into — the archive sections are the rest. */
const studySections = (result: FormatDecode.Result<string>): readonly DecodedFile.Section[] =>
  result.decoded.sections.filter((section) =>
    section.resources.some((one) => one.key.endsWith('imaging-study'))
  )

/** A study fixture's files, ready to pick. */
const picksOf = (fixture: StudyFixture): readonly PickedFile.Type[] => writeStudy(fixture).map(pick)

const TAGS = {
  StudyInstanceUID: '1.2.3.4.5',
  PatientID: 'P001',
  PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
  Modality: 'CT',
} as const

/** One file of the canonical study, varied by whichever tags a case cares about. */
const file = (fileName: string, overrides: Record<string, unknown> = {}): PickedFile.Type =>
  pick({
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

  it('mints one archive per file, all filed under the patient and related to the study', async () => {
    const result = await run([
      file('1', { SOPInstanceUID: 'I1', InstanceNumber: 1 }),
      file('2', { SOPInstanceUID: 'I2', InstanceNumber: 2 }),
    ])
    const archives = archivesOf(result)
    expect(archives).toHaveLength(2)

    const [study] = studiesOf(result)
    const [patient] = of(result, 'Patient')
    for (const archive of archives) {
      expect(archive.subject?.reference).toBe(`Patient/${patient.id}`)
      expect(archive.context?.related.map((one) => one.reference)).toEqual([
        `ImagingStudy/${study.id}`,
      ])
    }
  })

  it('lists the archives in one "Source files" section ahead of the study', async () => {
    const result = await run([
      file('1', { SOPInstanceUID: 'I1' }),
      file('2', { SOPInstanceUID: 'I2' }),
    ])
    const [first] = result.decoded.sections
    expect(first.title).toBe('Source files')
    expect(first.resources.map((one) => one.key)).toEqual([
      '0:1/source-file/1',
      '1:2/source-file/2',
    ])
  })

  it('gives each instance the archive of its own file', async () => {
    const result = await run([
      file('1', { SOPInstanceUID: 'I1', InstanceNumber: 1 }),
      file('2', { SOPInstanceUID: 'I2', InstanceNumber: 2 }),
    ])
    const archiveIds = archivesOf(result).map((one) => one.id)
    const [study] = studiesOf(result)
    const instanceFileIds = study.series.flatMap((series) =>
      series.instance.map((instance) => instance.extension[0]?.valueString)
    )
    expect(new Set(instanceFileIds)).toEqual(new Set(archiveIds))
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
    // Same StudyInstanceUID, so the studies share an id — but they are two
    // reviewable units under two patients, never one silently merged study.
    expect(studiesOf(result)).toHaveLength(2)
    expect(new Set(of(result, 'Patient').map((one) => one.id)).size).toBe(2)
  })

  it('reports an unparsable file on its own, leaving the study readable', async () => {
    const result = await run([
      file('1', { SOPInstanceUID: 'I1' }),
      pick({ fileName: 'junk.dcm', bytes: new Uint8Array([0x00, 0x01, 0x02]) }),
    ])
    expect(result.unreadableFiles.map((one) => one.title)).toEqual(['junk.dcm'])
    expect(studiesOf(result)).toHaveLength(1)
  })

  it('fails every file rather than guessing when the time zone is not a zone', async () => {
    const files = [file('1', { SOPInstanceUID: 'I1' }), file('2', { SOPInstanceUID: 'I2' })]
    const result = await Effect.runPromise(decode(files, { timeZone: 'Mars/Olympus' }))
    expect(result.unreadableFiles).toHaveLength(2)
    expect(result.decoded.sections).toEqual([])
  })

  it('links a server-picked file to its existing archive and mints none', async () => {
    const [onlyFile] = [file('1', { SOPInstanceUID: 'I1' })]
    const result = await run([{ ...onlyFile, source: PickedFile.Source.server('doc-9') }])
    expect(archivesOf(result)).toEqual([])
    for (const entry of resourcesOf(result)) {
      expect(entry.resource.meta?.source).toBe('DocumentReference/doc-9')
    }
  })

  describe('over a generated study', () => {
    const decodedStudy = async (
      fixture: StudyFixture,
      files: readonly PickedFile.Type[]
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
          const bodies = (result: FormatDecode.Result<string>): readonly unknown[] =>
            resourcesOf(result)
              .map((entry) => entry.resource)
              .filter((resource) => resource.resourceType !== 'DocumentReference')
              .toSorted((left, right) => (left.id ?? '').localeCompare(right.id ?? ''))
          expect(bodies(reversed)).toEqual(bodies(forward))
        }),
        { numRuns: numRunsFor({ base: 20 }) }
      )
    })
  })
})

describe('the DICOM importer', () => {
  it('exposes the same importer shape every other format does', () => {
    // The decode is the format's own, built from its partition: what a
    // consumer holds is the same `FileImporter.Type` every format exposes.
    const importer: FileImporter.Type<DicomSettings, 'dicom'> = dicomImporter
    expect(importer.format).toBe('dicom')
  })
})

describe('partitionStudies', () => {
  const member = (
    fileName: string,
    overrides: DicomTagMap = {},
    index = 0
  ): { readonly file: PickedFile.Type; readonly index: number } => ({
    file: file(fileName, overrides),
    index,
  })

  it('groups the files of one study into one set, in study order', () => {
    const picked = [
      member('2', { SOPInstanceUID: 'I2', InstanceNumber: 2 }, 0),
      member('1', { SOPInstanceUID: 'I1', InstanceNumber: 1 }, 1),
    ]
    const { fileSets, unreadable } = partitionStudies(picked)
    expect(unreadable).toEqual([])
    expect(fileSets).toHaveLength(1)
    // Study order, not pick order — which is what makes the representative
    // (and with it the key namespace and the meta.source stamp) independent
    // of how the reviewer picked the files.
    expect(fileSets[0]?.map((one) => one.file.fileName)).toEqual(['1', '2'])
  })

  it('keys a study by its UID and its patient, so a differing patient splits it', () => {
    const picked = [
      member('1', { PatientID: 'P001', SOPInstanceUID: 'I1' }, 0),
      member('2', { PatientID: 'P002', SOPInstanceUID: 'I2' }, 1),
    ]
    const { fileSets } = partitionStudies(picked)
    expect(fileSets).toHaveLength(2)
    const keys = fileSets.map((set) => studyKey(set[0].header))
    expect(new Set(keys).size).toBe(2)
  })

  it('leaves a file whose header does not parse out of every set', () => {
    const picked = [
      member('1', { SOPInstanceUID: 'I1' }, 0),
      { file: pick({ fileName: 'junk.dcm', bytes: new Uint8Array([0, 1, 2]) }), index: 1 },
    ]
    const { fileSets, unreadable } = partitionStudies(picked)
    expect(fileSets).toHaveLength(1)
    expect(unreadable.map((one) => one.member.file.fileName)).toEqual(['junk.dcm'])
  })

  it('property: every pick lands in exactly one set or in unreadable', () => {
    fc.assert(
      fc.property(dicomStudyArb(), (fixture) => {
        const picked = picksOf(fixture).map((one, index) => ({ file: one, index }))
        const { fileSets, unreadable } = partitionStudies(picked)
        const placed = fileSets.flatMap((set) => set.map((one) => one.index))
        const byNumber = (left: number, right: number): number => left - right
        expect(
          [...placed, ...unreadable.map((one) => one.member.index)].toSorted(byNumber)
        ).toEqual(picked.map((one) => one.index).toSorted(byNumber))
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})
