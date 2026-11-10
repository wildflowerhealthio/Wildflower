import { writeDicom } from '@wildflowerhealthio/dicom/test-helpers'
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  DecodeFunction,
  type PickedFile,
  type ReviewRow,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { PositionedTextExtractor } from '@wildflowerhealthio/positioned-text'
import { Array as Arr, Effect, Layer, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  claimPicks,
  type DecodedBatch,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
} from './read-batch.ts'
import { defaultFormatSettings, type FormatKind, formatKinds, formatRegistry } from './registry.ts'
import { isSourceFileOf } from './resolve-mentions.ts'
import * as ReviewGroup from './review-group.ts'

/**
 * The batch read over a fake registry whose formats claim files by name
 * prefix and decode by a settings-driven rule — enough to pin the claiming,
 * the deterministic ids, and the settings re-decode without any real
 * format — plus one pass over the real registry to show the claiming holds
 * with a genuine DICOM file and a PDF beside an unrecognized one.
 */

/** A pick claimed by the fake format named in its file name (`har-…`, `pdf-…`, `dcm-…`), or by none. */
const pickArbitrary: fc.Arbitrary<PickedFile.NamedBytes> = fc
  .tuple(
    fc.constantFrom('har', 'pdf', 'dcm', 'txt'),
    fc.stringMatching(/^[a-z0-9]{1,6}$/u),
    fc.uint8Array({ minLength: 1, maxLength: 4 })
  )
  .map(([prefix, stem, bytes]) => ({ fileName: `${prefix}-${stem}`, bytes }))

/** A batch of picks with unique file names, so a test can name one by its name alone. */
const batchArbitrary = (maxLength: number): fc.Arbitrary<PickedFile.NamedBytes[]> =>
  fc.uniqueArray(pickArbitrary, { maxLength, selector: (pick) => pick.fileName })

/** The picks with the ids `readBatch` stamps them with — its own derivation, restated. */
const withIds = (picks: readonly PickedFile.NamedBytes[]): readonly PickedFile.Type[] =>
  picks.map((pick, index) => ({ ...pick, id: `${index}:${pick.fileName}` }))

const kindOf = (fileName: string): FormatKind | undefined => {
  if (fileName.startsWith('har-')) return 'har'
  if (fileName.startsWith('pdf-')) return 'lifelabs-pdf'
  if (fileName.startsWith('dcm-')) return 'dicom'
  return undefined
}

/** `kind`'s group of `batch`, failing the test when the format took no part. */
const groupOf = (batch: DecodedBatch, kind: FormatKind): ReviewGroup.Type => {
  const group = batch.groups[kind]
  if (group === undefined) throw expect.fail(`expected ${kind} to take part`)
  return group
}

/** Every review key a format's group offers, in review order. */
const reviewKeys = (group: ReviewGroup.Type): readonly string[] =>
  ReviewGroup.rows(group).map((row) => row.reviewKey)

/** A Patient its source calls `id`, detached as a decoder hands it over. */
const fakeResource = (id: string): DetachedResource.Type =>
  DetachedResource.fromServerRecord('https://example.test/fhir')(
    Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })
  )

/** A fake decode: one section per file, under the settings. A file whose first byte is 0 is unreadable. */
const fakeDecode = <K extends FormatKind>(kind: K): DecodeFunction.Type<unknown, K> =>
  DecodeFunction.make({
    format: kind,
    decodeFileSet: ([file], settings) =>
      file.bytes[0] === 0
        ? Effect.fail(
            new ParseResult.ParseError({
              issue: new ParseResult.Type(Schema.Unknown.ast, file.fileName, 'zero'),
            })
          )
        : Effect.succeed({
            pickedFiles: [DecodedFileSet.unidentified(file)],
            sectionedList: SectionedList.make([
              Section.make(`${kind}:${JSON.stringify(settings)}`, [
                {
                  localKey: `r:${file.fileName}`,
                  resource: fakeResource(`${kind}-${file.fileName}`),
                },
              ]),
            ]),
            notes: [],
          }),
  })

/** Source-file constants for a fake format. */
const sourceFileFormatOf = (kind: FormatKind): PickedFile.FormatValue => ({
  coding: { system: 'https://example.test/fhir/CodeSystem/source-file', code: kind },
  contentType: 'application/octet-stream',
  descriptionPrefix: `${kind}: `,
})

/** The sections a format's decode read out of its files, its source file sections left out. */
const extractedSections = (group: ReviewGroup.Type): readonly Section.Type<ReviewRow.Type>[] =>
  group.sectionedList.sections.filter((section) => section.title !== 'Source file')

const fakeRegistry: ReadRegistry<never> = {
  har: {
    format: 'har',
    detect: (_b: Uint8Array, name: string) => kindOf(name) === 'har',
    decode: fakeDecode('har'),
    sourceFileFormat: sourceFileFormatOf('har'),
  },
  'lifelabs-pdf': {
    format: 'lifelabs-pdf',
    detect: (_b: Uint8Array, name: string) => kindOf(name) === 'lifelabs-pdf',
    decode: fakeDecode('lifelabs-pdf'),
    sourceFileFormat: sourceFileFormatOf('lifelabs-pdf'),
  },
  dicom: {
    format: 'dicom',
    detect: (_b: Uint8Array, name: string) => kindOf(name) === 'dicom',
    decode: fakeDecode('dicom'),
    sourceFileFormat: sourceFileFormatOf('dicom'),
  },
}

describe('claimPicks', () => {
  it('property: every pick is claimed by exactly one format (or unrecognized), pick order kept within each', () => {
    fc.assert(
      fc.property(fc.array(pickArbitrary), (picks) => {
        const stamped = withIds(picks)
        const { claimed, unrecognized } = claimPicks(fakeRegistry, picks)
        const reclaimed = Object.values(claimed).flat().concat(unrecognized)
        expect(reclaimed.length).toBe(picks.length)
        for (const [kind, files] of Object.entries(claimed)) {
          expect(files).toEqual(stamped.filter((pick) => kindOf(pick.fileName) === kind))
        }
        expect(unrecognized).toEqual(stamped.filter((pick) => kindOf(pick.fileName) === undefined))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: the id it stamps is the slot in the whole batch, whatever format claimed it', () => {
    fc.assert(
      fc.property(fc.array(pickArbitrary, { maxLength: 8 }), (picks) => {
        const { claimed, unrecognized } = claimPicks(fakeRegistry, picks)
        const everyPick = Object.values(claimed).flat().concat(unrecognized)
        const ids = new Map(everyPick.map((pick) => [pick.id, pick]))
        expect(ids.size).toBe(picks.length)
        for (const [index, pick] of picks.entries()) {
          expect(ids.get(`${index}:${pick.fileName}`)?.bytes).toEqual(pick.bytes)
        }
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})

describe('readBatch', () => {
  it('property: every format gets its claimed files, unreadable files separate from decoded, unrecognized files collected', async () => {
    await fc.assert(
      fc.asyncProperty(batchArbitrary(8), async (picks) => {
        const batch = await Effect.runPromise(readBatch(fakeRegistry, defaultFormatSettings, picks))
        const stamped = withIds(picks)
        for (const kind of formatKinds) {
          const expectedFiles = stamped.filter((pick) => kindOf(pick.fileName) === kind)
          expect(batch.groups[kind] === undefined).toBe(expectedFiles.length === 0)
        }
        for (const [kind, group] of ReviewGroup.entries(batch.groups, formatKinds)) {
          const expectedFiles = stamped.filter((pick) => kindOf(pick.fileName) === kind)
          expect(group.files).toEqual(expectedFiles)
          const expectedReadable = expectedFiles.filter((f) => f.bytes[0] !== 0)
          const expectedUnreadable = expectedFiles.filter((f) => f.bytes[0] === 0)
          expect(extractedSections(group).length).toBe(expectedReadable.length)
          expect(group.unreadableFiles.length).toBe(expectedUnreadable.length)
        }
        const expectedUnrecognized = picks.filter((pick) => kindOf(pick.fileName) === undefined)
        expect(batch.unrecognizedFiles.length).toBe(expectedUnrecognized.length)
        for (const [index, file] of batch.unrecognizedFiles.entries()) {
          expect(file.title).toBe(expectedUnrecognized[index]?.fileName)
        }
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  it('should decode each format under its own settings', async () => {
    const settings = {
      ...defaultFormatSettings,
      'lifelabs-pdf': { ...defaultFormatSettings['lifelabs-pdf'], timeZone: 'America/Vancouver' },
    }
    const batch = await Effect.runPromise(
      readBatch(fakeRegistry, settings, [{ fileName: 'pdf-a', bytes: new Uint8Array([1]) }])
    )
    expect(extractedSections(groupOf(batch, 'lifelabs-pdf'))[0]?.title).toBe(
      `lifelabs-pdf:${JSON.stringify(settings['lifelabs-pdf'])}`
    )
  })
})

describe('redecodeFormat', () => {
  it('property: only the changed format re-decodes, under its new settings and its old ids; every other format keeps its reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        batchArbitrary(8),
        fc.constantFrom(...formatKinds),
        async (picks, changed) => {
          const before = await Effect.runPromise(
            readBatch(fakeRegistry, defaultFormatSettings, picks)
          )
          const settings = { ...defaultFormatSettings, [changed]: { marker: 'changed' } }
          const after = await Effect.runPromise(
            redecodeFormat(fakeRegistry, settings, changed, before)
          )
          for (const kind of formatKinds) {
            if (kind !== changed) {
              expect(after.groups[kind]).toBe(before.groups[kind])
              continue
            }
            const groupAfter = after.groups[kind]
            const groupBefore = before.groups[kind]
            if (groupBefore === undefined) {
              expect(after).toBe(before)
              continue
            }
            if (groupAfter === undefined) throw expect.fail(`expected ${kind} to keep its group`)
            // The ids the reviewer's selection is keyed by survive the re-decode.
            expect(groupAfter.files).toBe(groupBefore.files)
            expect(groupAfter.unreadableFiles.map((file) => file.id)).toEqual(
              groupBefore.unreadableFiles.map((file) => file.id)
            )
            expect(reviewKeys(groupAfter)).toEqual(reviewKeys(groupBefore))
            for (const section of extractedSections(groupAfter)) {
              expect(section.title).toBe(`${changed}:${JSON.stringify(settings[changed])}`)
            }
          }
          expect(after.unrecognizedFiles).toBe(before.unrecognizedFiles)
        }
      ),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})

/** An extractor that reads every PDF as one blank Letter page — a PDF that is no LifeLabs report. */
const extractorReadingBlankPage = Layer.succeed(PositionedTextExtractor, {
  extract: () =>
    Effect.succeed({
      format: 'wildflower-positioned-text',
      version: 1,
      pages: [{ pageNumber: 1, width: 612, height: 792, runs: [] }],
    }),
})

describe('readBatch over the real registry', () => {
  it('should read a DICOM file into a decoded result with its Source file section, run a PDF through the extractor, and leave a text file unrecognized', async () => {
    const dicomBytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
      PatientID: 'P001',
      Modality: 'CT',
    })
    const picks: readonly PickedFile.NamedBytes[] = [
      { fileName: 'notes.txt', bytes: new TextEncoder().encode('hello') },
      { fileName: 'scan.dcm', bytes: dicomBytes },
      { fileName: 'blank.pdf', bytes: new TextEncoder().encode('%PDF-1.7 stand-in') },
    ]
    const batch = await Effect.runPromise(
      readBatch(formatRegistry, defaultFormatSettings, picks).pipe(
        Effect.provide(extractorReadingBlankPage)
      )
    )
    const dicom = groupOf(batch, 'dicom')
    const lifeLabs = groupOf(batch, 'lifelabs-pdf')
    expect(lifeLabs.files.map((file) => file.fileName)).toEqual(['blank.pdf'])
    expect(lifeLabs.unreadableFiles.map((file) => file.title)).toEqual(['blank.pdf'])
    expect(dicom.files.length).toBe(1)
    expect(dicom.sectionedList.sections[0]?.title).toBe('Source file')
    expect(dicom.sectionedList.sections.length).toBeGreaterThan(1)
    expect(batch.unrecognizedFiles.length).toBe(1)
    expect(batch.unrecognizedFiles[0]?.title).toBe('notes.txt')
  })
})

/** One file of a two-file DICOM study, named by its instance. */
const studyFile = (instance: number): PickedFile.NamedBytes => ({
  fileName: `scan-${instance}.dcm`,
  bytes: writeDicom({
    StudyInstanceUID: '1.2.3.4.5',
    SeriesInstanceUID: '1.2.3.4.5.1',
    SOPInstanceUID: `1.2.3.4.5.1.${instance}`,
    InstanceNumber: instance,
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
    PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
    PatientID: 'P001',
    Modality: 'CT',
  }),
})

describe('a DICOM study read over the real registry', () => {
  const readStudy = async (
    picks: readonly PickedFile.NamedBytes[]
  ): Promise<readonly FhirResourceWithId[]> => {
    const batch = await Effect.runPromise(
      readBatch(formatRegistry, defaultFormatSettings, picks).pipe(
        Effect.provide(extractorReadingBlankPage)
      )
    )
    const dicom = groupOf(batch, 'dicom')
    expect(dicom.unreadableFiles).toEqual([])
    return ReviewGroup.rows(dicom).map((row) => row.resource)
  }

  it("files every source file under the study's patient, each instance naming its own, every record stamped with the smallest", async () => {
    const resources = await readStudy([studyFile(1), studyFile(2)])
    const sourceFiles = resources.filter((one) => isSourceFileOf('dicom', one))
    const [patient] = resources.filter((one) => one.resourceType === 'Patient')
    const [study] = resources.filter((one) => one.resourceType === 'ImagingStudy')
    if (study?.resourceType !== 'ImagingStudy') throw expect.fail('expected an ImagingStudy')
    const sourceFileIdByName = new Map(
      sourceFiles.map((one) => [
        one.resourceType === 'DocumentReference' ? one.content[0]?.attachment.title : null,
        one.id,
      ])
    )

    expect(
      sourceFiles.map((one) =>
        one.resourceType === 'DocumentReference'
          ? [one.subject?.reference, one.context?.related.map((related) => related.reference)]
          : []
      )
    ).toEqual(Arr.makeBy(2, () => [`Patient/${patient?.id}`, [`ImagingStudy/${study.id}`]]))
    expect(study.series[0]?.instance.map((instance) => instance.extension[0]?.valueString)).toEqual(
      [sourceFileIdByName.get('scan-1.dcm'), sourceFileIdByName.get('scan-2.dcm')]
    )
    const [smallest] = sourceFiles.map((one) => one.id).toSorted()
    expect(
      new Set(
        resources.filter((one) => !isSourceFileOf('dicom', one)).map((one) => one.meta?.source)
      )
    ).toEqual(new Set([`DocumentReference/${smallest}`]))
  })

  it('reads the same study, picked in any order, to the same records', async () => {
    const recordsOf = async (
      picks: readonly PickedFile.NamedBytes[]
    ): Promise<readonly FhirResourceWithId[]> =>
      (await readStudy(picks)).filter((one) => !isSourceFileOf('dicom', one))
    expect(await recordsOf([studyFile(2), studyFile(1)])).toEqual(
      await recordsOf([studyFile(1), studyFile(2)])
    )
  })
})

describe('readBatch, the formats that take part', () => {
  it('property: gives a group to exactly the formats a pick gave files to, in registry order', async () => {
    await fc.assert(
      fc.asyncProperty(batchArbitrary(6), async (picks) => {
        const batch = await Effect.runPromise(readBatch(fakeRegistry, defaultFormatSettings, picks))
        const expected = formatKinds.filter((kind) =>
          picks.some((pick) => kindOf(pick.fileName) === kind)
        )
        expect(ReviewGroup.entries(batch.groups, formatKinds).map(([kind]) => kind)).toEqual(
          expected
        )
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('gives no format a group for a batch of unrecognized picks only', async () => {
    const batch = await Effect.runPromise(
      readBatch(fakeRegistry, defaultFormatSettings, [
        { fileName: 'txt-a', bytes: new Uint8Array([1]) },
      ])
    )
    expect(batch.groups).toEqual({})
  })
})

describe('unrecognized picks', () => {
  it('gives two same-named unrecognized picks distinct ids', async () => {
    const pick = (): PickedFile.NamedBytes => ({
      fileName: 'txt-same',
      bytes: new Uint8Array([1]),
    })
    const batch = await Effect.runPromise(
      readBatch(fakeRegistry, defaultFormatSettings, [pick(), pick()])
    )
    const ids = batch.unrecognizedFiles.map((file) => file.id)
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
  })
})
