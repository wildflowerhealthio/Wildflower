import { writeDicom } from 'dicom/test-helpers'
import { Effect, Either, ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { type FhirResource, Patient } from 'fhir-r4/resources'
import {
  PickedFileSource,
  type PickedFile,
  type ReadUnit,
  SourceFile,
  type UnreadableUnit,
  unitId,
} from 'importer-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  entryFormat,
  entryId,
  groupByFormat,
  readBatch,
  type ReadRegistry,
  redecodeFormat,
} from './read-batch.ts'
import { defaultFormatSettings, type FormatKind, formatRegistry } from './registry.ts'

/**
 * The batch read over a fake registry whose formats claim files by name
 * prefix and decode by a settings-driven rule — enough to pin the grouping,
 * the deterministic ids, and the settings re-decode without any real
 * format — plus one pass over the real registry to show the grouping holds
 * with a genuine DICOM file beside an unrecognized one.
 */

/** A pick claimed by the fake format named in its file name (`har-…`, `pdf-…`, `dcm-…`), or by none. */
const pickArbitrary: fc.Arbitrary<PickedFile> = fc
  .tuple(
    fc.constantFrom('har', 'pdf', 'dcm', 'txt'),
    fc.stringMatching(/^[a-z0-9]{1,6}$/u),
    fc.uint8Array({ minLength: 1, maxLength: 4 })
  )
  .map(([prefix, stem, bytes]) => ({
    fileName: `${prefix}-${stem}`,
    bytes,
    source: PickedFileSource.local,
  }))

const kindOf = (fileName: string): FormatKind | undefined => {
  if (fileName.startsWith('har-')) return 'har'
  if (fileName.startsWith('pdf-')) return 'lifelabs-pdf'
  if (fileName.startsWith('dcm-')) return 'dicom'
  return undefined
}

const fakeResource = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', id })

/** A fake decode: one unit per file, returning Either<ReadUnit, UnreadableUnit> with deterministic ids. A file whose first byte is 0 is unreadable. */
const fakeDecode =
  <K extends FormatKind>(kind: K) =>
  (
    files: readonly PickedFile[],
    settings: unknown
  ): Effect.Effect<readonly Either.Either<ReadUnit<FhirResource, K>, UnreadableUnit<K>>[]> =>
    Effect.succeed(
      files.map((file) =>
        file.bytes[0] === 0
          ? Either.left({
              _tag: 'UnreadableUnit' as const,
              id: unitId(kind, [file]),
              title: file.fileName,
              files: [file],
              format: kind,
              error: new ParseResult.ParseError({
                issue: new ParseResult.Type(Schema.Unknown.ast, file.fileName, 'zero'),
              }),
            })
          : Either.right({
              id: unitId(kind, [file]),
              title: file.fileName,
              files: [file] as readonly PickedFile[],
              format: kind,
              decoded: {
                sections: [
                  {
                    title: `${kind}:${JSON.stringify(settings)}`,
                    resources: [
                      {
                        key: 'r',
                        title: 'Patient/r',
                        resource: fakeResource(`${kind}-${file.fileName}`),
                      },
                    ],
                  },
                ],
                notes: [],
              },
            })
      )
    )

const fakeRegistry: ReadRegistry = {
  har: { format: 'har', detect: (_b, name) => kindOf(name) === 'har', decode: fakeDecode('har') },
  'lifelabs-pdf': {
    format: 'lifelabs-pdf',
    detect: (_b, name) => kindOf(name) === 'lifelabs-pdf',
    decode: fakeDecode('lifelabs-pdf'),
  },
  dicom: {
    format: 'dicom',
    detect: (_b, name) => kindOf(name) === 'dicom',
    decode: fakeDecode('dicom'),
  },
}

/** Whether a pick should be right (decoded), left-unreadable, or left-unrecognized. */
const expectedSide = (pick: PickedFile): 'right' | 'unreadable' | 'unrecognized' => {
  if (kindOf(pick.fileName) === undefined) return 'unrecognized'
  return pick.bytes[0] === 0 ? 'unreadable' : 'right'
}

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
  it('property: one outcome per pick, tagged by its format, unreadable exactly for a zero-led file, ids deterministic', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(pickArbitrary, { maxLength: 8 }), async (picks) => {
        const units = await Effect.runPromise(readBatch(fakeRegistry, defaultFormatSettings, picks))
        expect(units.length).toBe(picks.length)
        expect(new Set(units.map(entryId)).size).toBe(units.length)
        for (const unit of units) {
          const files = Either.isRight(unit) ? unit.right.files : unit.left.files
          const pick = files[0]
          if (pick === undefined) throw new Error('a unit always carries its pick')
          const title = Either.isRight(unit) ? unit.right.title : unit.left.title
          expect(title).toBe(pick.fileName)
          expect(entryFormat(unit)).toBe(kindOf(pick.fileName))
          const side = expectedSide(pick)
          if (side === 'right') {
            expect(Either.isRight(unit)).toBe(true)
          } else {
            expect(Either.isLeft(unit)).toBe(true)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  it('should decode each format under its own settings', async () => {
    const settings = { ...defaultFormatSettings, har: { disabledKinds: ['X'] } }
    const [unit] = await Effect.runPromise(
      readBatch(fakeRegistry, settings, [
        { fileName: 'har-a', bytes: new Uint8Array([1]), source: PickedFileSource.local },
      ])
    )
    if (unit === undefined || !Either.isRight(unit)) throw new Error('expected a read unit')
    expect(unit.right.decoded.sections[0]?.title).toBe(`har:${JSON.stringify(settings.har)}`)
  })
})

describe('redecodeFormat', () => {
  it('property: only the changed format re-decodes; every unit keeps its id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(pickArbitrary, { maxLength: 8 }),
        fc.constantFrom<FormatKind>('har', 'lifelabs-pdf', 'dicom'),
        async (picks, changed) => {
          const before = await Effect.runPromise(
            readBatch(fakeRegistry, defaultFormatSettings, picks)
          )
          const settings = { ...defaultFormatSettings, [changed]: { marker: 'changed' } }
          const after = await Effect.runPromise(
            redecodeFormat(fakeRegistry, settings, changed, before)
          )
          expect(after.map(entryId)).toEqual(before.map(entryId))
          for (const [index, unit] of after.entries()) {
            const previous = before[index]
            if (previous === undefined) throw new Error('same length')
            if (entryFormat(previous) !== changed) {
              expect(unit).toBe(previous)
            } else if (Either.isRight(unit)) {
              expect(unit.right.decoded.sections[0]?.title).toBe(
                `${changed}:${JSON.stringify(settings[changed])}`
              )
            }
          }
        }
      ),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})

describe('readBatch over the real registry', () => {
  it('should read a DICOM file into a titled unit with its Source file section, and leave a text file unrecognized', async () => {
    const dicomBytes = writeDicom({
      StudyInstanceUID: '1.2.3.4.5',
      SeriesInstanceUID: '1.2.3.4.5.1',
      SOPInstanceUID: '1.2.3.4.5.1.1',
      PatientName: { family: 'Doe', given: 'John', text: 'Doe John' },
      PatientID: 'P001',
      Modality: 'CT',
    })
    const picks: readonly PickedFile[] = [
      {
        fileName: 'notes.txt',
        bytes: new TextEncoder().encode('hello'),
        source: PickedFileSource.local,
      },
      { fileName: 'scan.dcm', bytes: dicomBytes, source: PickedFileSource.local },
    ]
    const units = await Effect.runPromise(readBatch(formatRegistry, defaultFormatSettings, picks))
    expect(
      units.map((unit) => [
        Either.isRight(unit) ? 'read' : 'left',
        Either.isRight(unit) ? unit.right.title : unit.left.title,
      ])
    ).toEqual([
      ['read', 'scan.dcm'],
      ['left', 'notes.txt'],
    ])
    const dicom = units[0]
    if (dicom === undefined || !Either.isRight(dicom)) throw new Error('expected a read unit')
    expect(dicom.right.format).toBe('dicom')
    expect(dicom.right.decoded.sections[0]?.title).toBe(SourceFile.SECTION_TITLE)
    expect(dicom.right.decoded.sections.length).toBeGreaterThan(1)
  })
})
