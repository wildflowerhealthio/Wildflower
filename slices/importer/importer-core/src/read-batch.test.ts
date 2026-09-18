import { writeDicom } from 'dicom/test-helpers'
import { Effect, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import { PickedFile, FormatDecode, SourceFile } from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  claimedFormats,
  groupByFormat,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
} from './read-batch.ts'
import { defaultFormatSettings, type FormatKind, formatKinds, formatRegistry } from './registry.ts'

/**
 * The batch read over a fake registry whose formats claim files by name
 * prefix and decode by a settings-driven rule — enough to pin the grouping,
 * the deterministic ids, and the settings re-decode without any real
 * format — plus one pass over the real registry to show the grouping holds
 * with a genuine DICOM file beside an unrecognized one.
 */

/** A pick claimed by the fake format named in its file name (`har-…`, `pdf-…`, `dcm-…`), or by none. */
const pickArbitrary: fc.Arbitrary<PickedFile.Type> = fc
  .tuple(
    fc.constantFrom('har', 'pdf', 'dcm', 'txt'),
    fc.stringMatching(/^[a-z0-9]{1,6}$/u),
    fc.uint8Array({ minLength: 1, maxLength: 4 })
  )
  .map(([prefix, stem, bytes]) => ({
    fileName: `${prefix}-${stem}`,
    bytes,
    source: PickedFile.Source.local,
  }))

/** A batch of picks with unique file names — deterministic ids are keyed on file name, so duplicates would collide. */
const batchArbitrary = (maxLength: number): fc.Arbitrary<PickedFile.Type[]> =>
  fc.uniqueArray(pickArbitrary, { maxLength, selector: (pick) => pick.fileName })

const kindOf = (fileName: string): FormatKind | undefined => {
  if (fileName.startsWith('har-')) return 'har'
  if (fileName.startsWith('pdf-')) return 'lifelabs-pdf'
  if (fileName.startsWith('dcm-')) return 'dicom'
  return undefined
}

const fakeResource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A fake decode: aggregates files into one FormatDecodeResult. A file whose first byte is 0 is unreadable. */
const fakeDecode =
  <K extends FormatKind>(kind: K) =>
  (files: readonly PickedFile.Type[], settings: unknown): Effect.Effect<FormatDecode.Result<K>> =>
    Effect.succeed({
      id: FormatDecode.makeId(kind, files),
      title: files.map((f) => f.fileName).join(', '),
      files,
      format: kind,
      decoded: {
        sections: files
          .filter((file) => file.bytes[0] !== 0)
          .map((file) => ({
            title: `${kind}:${JSON.stringify(settings)}`,
            resources: [
              {
                key: `r:${file.fileName}`,
                title: `Patient/${kind}-${file.fileName}`,
                resource: fakeResource(`${kind}-${file.fileName}`),
              },
            ],
          })),
        notes: [],
      },
      unreadableFiles: files
        .filter((file) => file.bytes[0] === 0)
        .map((file) => ({
          id: FormatDecode.makeId(kind, [file]),
          title: file.fileName,
          pickedFile: file,
          error: new ParseResult.ParseError({
            issue: new ParseResult.Type(Schema.Unknown.ast, file.fileName, 'zero'),
          }),
        })),
    })

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const fakeRegistry: ReadRegistry = {
  har: {
    format: 'har',
    detect: (_b: Uint8Array, name: string) => kindOf(name) === 'har',
    decode: fakeDecode('har'),
  },
  'lifelabs-pdf': {
    format: 'lifelabs-pdf',
    detect: (_b: Uint8Array, name: string) => kindOf(name) === 'lifelabs-pdf',
    decode: fakeDecode('lifelabs-pdf'),
  },
  dicom: {
    format: 'dicom',
    detect: (_b: Uint8Array, name: string) => kindOf(name) === 'dicom',
    decode: fakeDecode('dicom'),
  },
} as unknown as ReadRegistry

describe('groupByFormat', () => {
  it('property: every pick lands in exactly one group (or unrecognized), pick order kept within each', () => {
    fc.assert(
      fc.property(fc.array(pickArbitrary), (picks) => {
        const { groups, unrecognized } = groupByFormat(fakeRegistry, picks)
        const regrouped = [...groups.values()].flat().concat(unrecognized)
        expect(regrouped.length).toBe(picks.length)
        for (const [kind, files] of groups) {
          expect(files).toEqual(picks.filter((pick) => kindOf(pick.fileName) === kind))
        }
        expect(unrecognized).toEqual(picks.filter((pick) => kindOf(pick.fileName) === undefined))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('readBatch', () => {
  it('property: every format gets its claimed files, unreadable files separate from decoded, unrecognized files collected', async () => {
    await fc.assert(
      fc.asyncProperty(batchArbitrary(8), async (picks) => {
        const batch = await Effect.runPromise(readBatch(fakeRegistry, defaultFormatSettings, picks))
        for (const kind of formatKinds) {
          const result = batch[kind]
          const expectedFiles = picks.filter((pick) => kindOf(pick.fileName) === kind)
          expect(result.files).toEqual(expectedFiles)
          expect(result.format).toBe(kind)
          const expectedReadable = expectedFiles.filter((f) => f.bytes[0] !== 0)
          const expectedUnreadable = expectedFiles.filter((f) => f.bytes[0] === 0)
          expect(result.decoded.sections.length).toBe(expectedReadable.length)
          expect(result.unreadableFiles.length).toBe(expectedUnreadable.length)
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
    const settings = { ...defaultFormatSettings, har: { disabledKinds: ['X'] } }
    const batch = await Effect.runPromise(
      readBatch(fakeRegistry, settings, [
        { fileName: 'har-a', bytes: new Uint8Array([1]), source: PickedFile.Source.local },
      ])
    )
    expect(batch.har.decoded.sections[0]?.title).toBe(`har:${JSON.stringify(settings.har)}`)
  })
})

describe('redecodeFormat', () => {
  it('property: only the changed format re-decodes; every other format keeps its reference', async () => {
    await fc.assert(
      fc.asyncProperty(
        batchArbitrary(8),
        fc.constantFrom<FormatKind>('har', 'lifelabs-pdf', 'dicom'),
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
              expect(after[kind]).toBe(before[kind])
            } else if (after[kind].decoded.sections.length > 0) {
              expect(after[kind].decoded.sections[0]?.title).toBe(
                `${changed}:${JSON.stringify(settings[changed])}`
              )
            }
          }
          expect(after.unrecognizedFiles).toBe(before.unrecognizedFiles)
        }
      ),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})

describe('readBatch over the real registry', () => {
  it('should read a DICOM file into a decoded result with its Source file section, and leave a text file unrecognized', async () => {
    const dicomBytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
      PatientID: 'P001',
      Modality: 'CT',
    })
    const picks: readonly PickedFile.Type[] = [
      {
        fileName: 'notes.txt',
        bytes: new TextEncoder().encode('hello'),
        source: PickedFile.Source.local,
      },
      { fileName: 'scan.dcm', bytes: dicomBytes, source: PickedFile.Source.local },
    ]
    const batch = await Effect.runPromise(readBatch(formatRegistry, defaultFormatSettings, picks))
    expect(batch.dicom.files.length).toBe(1)
    expect(batch.dicom.decoded.sections[0]?.title).toBe(SourceFile.SECTION_TITLE)
    expect(batch.dicom.decoded.sections.length).toBeGreaterThan(1)
    expect(batch.unrecognizedFiles.length).toBe(1)
    expect(batch.unrecognizedFiles[0]?.title).toBe('notes.txt')
  })
})

describe('claimedFormats', () => {
  it('property: names exactly the formats a pick gave files to, in registry order', async () => {
    await fc.assert(
      fc.asyncProperty(batchArbitrary(6), async (picks) => {
        const batch = await Effect.runPromise(readBatch(fakeRegistry, defaultFormatSettings, picks))
        const expected = formatKinds.filter((kind) =>
          picks.some((pick) => kindOf(pick.fileName) === kind)
        )
        expect(claimedFormats(batch)).toEqual(expected)
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('names no format for a batch of unrecognized picks only', async () => {
    const batch = await Effect.runPromise(
      readBatch(fakeRegistry, defaultFormatSettings, [
        { fileName: 'txt-a', bytes: new Uint8Array([1]), source: PickedFile.Source.local },
      ])
    )
    expect(claimedFormats(batch)).toEqual([])
  })
})

describe('unrecognized picks', () => {
  it('gives two same-named unrecognized picks distinct ids', async () => {
    const pick = (): PickedFile.Type => ({
      fileName: 'txt-same',
      bytes: new Uint8Array([1]),
      source: PickedFile.Source.local,
    })
    const batch = await Effect.runPromise(
      readBatch(fakeRegistry, defaultFormatSettings, [pick(), pick()])
    )
    const ids = batch.unrecognizedFiles.map((file) => file.id)
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
  })
})
