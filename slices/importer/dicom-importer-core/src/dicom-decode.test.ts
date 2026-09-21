import { dicomStudyArb, writeDicom, writeStudy, type StudyFixture } from 'dicom/test-helpers'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import type { DocumentReference, FhirResource, ImagingStudy } from 'fhir-r4/resources'
import {
  type FileImporter,
  DecodedFile,
  PickedFile,
  type FormatDecode,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { dicomImporter } from './dicom-importer.ts'
import type { DicomSettings } from './settings.ts'

/**
 * The batch decode run through `FileImporter.make` rather than called
 * directly: that factory is what discharges the source-file context, and the
 * archives it mints under the format's real coding constants are half of what
 * these tests are about.
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

  it('splits a pick spanning two studies into two units', async () => {
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
  it('exposes a batch decode built without PerFileDecodeFunction', () => {
    // The decode is the format's own, bound by the factory: what a consumer
    // holds is the same `FileImporter.Type` every other format exposes.
    const importer: FileImporter.Type<DicomSettings, 'dicom'> = dicomImporter
    expect(importer.format).toBe('dicom')
  })
})
