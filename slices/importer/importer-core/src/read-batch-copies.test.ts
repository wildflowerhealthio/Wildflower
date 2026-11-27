import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { FhirResourceSchema } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFileSet,
  DecodeFunction,
  FileImporter,
  type FormatDecode,
  type PickedFile,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Either, Option, ParseResult, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  type BatchCopies,
  copiesOf,
  type FileSetNotes,
  readBatchCopies,
  rereadFormatCopies,
} from './index.ts'
import type { ReadRegistry } from './read-batch.ts'
import { defaultFormatSettings, type FormatKind, type FormatSettings } from './registry.ts'

/**
 * Covers a batch read into copies of records over a fake registry: what each
 * claimed format read, in registry order, its notes and its unreadable
 * files, the picks no format claimed, and every copy in plan order.
 */

const SOURCE = 'https://source.example/id'

const detached = (fields: object): DetachedResource.Type =>
  Either.getOrThrow(DetachedResource.decodeUnknownEither(FhirResourceSchema)(fields))

/** A Patient keyed by `value`. */
const patientKeyedBy = (value: string): DetachedResource.Type =>
  detached({ resourceType: 'Patient', identifier: [{ system: SOURCE, value }] })

const sourceFileFormatOf = (kind: FormatKind): PickedFile.FormatValue => ({
  coding: { system: 'https://example.test/fhir/CodeSystem/source-file', code: kind },
  contentType: 'application/octet-stream',
  descriptionPrefix: `${kind}: `,
})

/**
 * A fake decode of `kind`: each file one Patient keyed by its name, with a
 * note naming it; a file named `bad.*` its decode rejects.
 */
const decodeOneEach = <K extends FormatKind>(kind: K): DecodeFunction.Type<unknown, K> =>
  DecodeFunction.make({
    format: kind,
    decodeFileSet: ([file]) =>
      file.fileName.startsWith('bad.')
        ? Effect.fail(
            new ParseResult.ParseError({
              issue: new ParseResult.Type(Schema.Unknown.ast, file.fileName, 'rejected'),
            })
          )
        : Effect.succeed({
            pickedFiles: [DecodedFileSet.unidentified(file)],
            sectionedList: SectionedList.make([
              Section.make('records', [
                {
                  localKey: 'patient',
                  resource: patientKeyedBy(file.fileName),
                  sourceUrl: Option.none(),
                },
              ]),
            ]),
            notes: [`read ${file.fileName}`],
          }),
  })

/**
 * The fake registry: HAR claims `.har` picks and fails a set named
 * `lost.har` at the import stage, as a record naming a file its set lacks;
 * LifeLabs claims `.pdf` picks; DICOM claims nothing.
 */
const registry: ReadRegistry<never> = {
  har: {
    format: 'har',
    detect: (_bytes, name) => name.endsWith('.har'),
    decode: decodeOneEach('har'),
    sourceFileFormat: sourceFileFormatOf('har'),
    linkToSourceFiles: (resource, sourceFiles) =>
      sourceFiles.some(({ pickedFile }) => pickedFile.fileName === 'lost.har')
        ? Effect.fail(
            new FileImporter.SourceFileNotFound({
              identifier: Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({
                system: SOURCE,
                value: 'missing-file',
              }),
            })
          )
        : Effect.succeed(resource),
  },
  'lifelabs-pdf': {
    format: 'lifelabs-pdf',
    detect: (_bytes, name) => name.endsWith('.pdf'),
    decode: decodeOneEach('lifelabs-pdf'),
    sourceFileFormat: sourceFileFormatOf('lifelabs-pdf'),
  },
  dicom: {
    format: 'dicom',
    detect: () => false,
    decode: () => Effect.die('never claimed'),
    sourceFileFormat: sourceFileFormatOf('dicom'),
  },
}

const pick = (fileName: string): PickedFile.NamedBytes => ({
  fileName,
  bytes: new TextEncoder().encode(fileName),
})

/** The titles of `unreadableFiles`, beside the tag of the error each failed with. */
const unreadableOf = (unreadableFiles: readonly FormatDecode.UnreadableFile[]): readonly object[] =>
  unreadableFiles.map(({ title, error }) => ({ title, error: error._tag }))

/** Each file set's notes beside the ids of its picked files. */
const notesOf = (notes: readonly FileSetNotes[]): readonly object[] =>
  notes.map(({ origin, notes: noted }) => [origin.pickedFiles.map(({ id }) => id).join(','), noted])

/** A LifeLabs settings' time zone that no report can be read in. */
const NOWHERE = 'Nowhere/At_All'

/**
 * A fake LifeLabs decode that reads its settings: each file one Patient
 * keyed by its name, noting the time zone it was read in; a file is
 * rejected in {@link NOWHERE}.
 */
const decodeInZone = DecodeFunction.make({
  format: 'lifelabs-pdf',
  decodeFileSet: ([file], settings: FormatSettings['lifelabs-pdf']) =>
    settings.timeZone === NOWHERE
      ? Effect.fail(
          new ParseResult.ParseError({
            issue: new ParseResult.Type(Schema.Unknown.ast, settings.timeZone, 'unknown zone'),
          })
        )
      : Effect.succeed({
          pickedFiles: [DecodedFileSet.unidentified(file)],
          sectionedList: SectionedList.make([
            Section.make('records', [
              {
                localKey: 'patient',
                resource: patientKeyedBy(file.fileName),
                sourceUrl: Option.none(),
              },
            ]),
          ]),
          notes: [`read ${file.fileName} in ${settings.timeZone}`],
        }),
})

/** {@link registry} with a LifeLabs decode that reads its settings. */
const zonedRegistry: ReadRegistry<never> = {
  ...registry,
  'lifelabs-pdf': { ...registry['lifelabs-pdf'], decode: decodeInZone },
}

/** Every format's default settings, LifeLabs' time zone `timeZone`. */
const settingsInZone = (timeZone: string): FormatSettings => ({
  ...defaultFormatSettings,
  'lifelabs-pdf': { ...defaultFormatSettings['lifelabs-pdf'], timeZone },
})

describe('readBatchCopies', () => {
  it('should read a mixed batch into each claimed format’s copies, notes and unreadable files, in registry order, beside the picks no format claimed', async () => {
    // Arrange
    const picks = ['r.pdf', 'a.har', 'notes.txt', 'bad.pdf', 'lost.har'].map(pick)

    // Act
    const read = await Effect.runPromise(readBatchCopies(registry, defaultFormatSettings, picks))

    // Assert
    expect({
      formats: read.formats.map(({ format, files, copies, notes, unreadableFiles }) => ({
        format,
        files: files.map(({ fileName }) => fileName),
        copies: copies.map(({ reviewKey }) => reviewKey),
        notes: notesOf(notes),
        unreadable: unreadableOf(unreadableFiles),
      })),
      unrecognized: read.unrecognizedFiles.map(({ title }) => title),
    }).toEqual({
      formats: [
        {
          format: 'har',
          files: ['a.har', 'lost.har'],
          copies: ['1:a.har/source-file/a.har', '1:a.har/patient'],
          notes: [['1:a.har', ['read a.har']]],
          unreadable: [{ title: 'lost.har', error: 'SourceFileNotFound' }],
        },
        {
          format: 'lifelabs-pdf',
          files: ['r.pdf', 'bad.pdf'],
          copies: ['0:r.pdf/source-file/r.pdf', '0:r.pdf/patient'],
          notes: [['0:r.pdf', ['read r.pdf']]],
          unreadable: [{ title: 'bad.pdf', error: 'ParseError' }],
        },
      ],
      unrecognized: ['notes.txt'],
    })
  })

  it('should give every format’s copies, format by format in registry order, as the plan’s copies', async () => {
    // Arrange
    const picks = ['r.pdf', 'a.har', 'b.har'].map(pick)

    // Act
    const read = await Effect.runPromise(readBatchCopies(registry, defaultFormatSettings, picks))

    // Assert
    expect(copiesOf(read).map(({ reviewKey }) => reviewKey)).toEqual([
      '1:a.har/source-file/a.har',
      '1:a.har/patient',
      '2:b.har/source-file/b.har',
      '2:b.har/patient',
      '0:r.pdf/source-file/r.pdf',
      '0:r.pdf/patient',
    ])
  })

  it('should read nothing from a batch no format claims', async () => {
    // Arrange / Act
    const read = await Effect.runPromise(
      readBatchCopies(registry, defaultFormatSettings, [pick('notes.txt')])
    )

    // Assert
    expect({
      formats: read.formats,
      copies: copiesOf(read),
      unrecognized: read.unrecognizedFiles.map(({ title }) => title),
    }).toEqual({ formats: [], copies: [], unrecognized: ['notes.txt'] })
  })
})

describe('rereadFormatCopies', () => {
  it('should read one format again under new settings, its copies, notes and unreadable files changing with them', async () => {
    // Arrange
    const picks = ['r.pdf', 'a.har', 's.pdf'].map(pick)
    const read = await Effect.runPromise(
      readBatchCopies(zonedRegistry, settingsInZone('America/Toronto'), picks)
    )

    // Act
    const [inVancouver, nowhere] = await Effect.runPromise(
      Effect.all(
        [settingsInZone('America/Vancouver'), settingsInZone(NOWHERE)].map((settings) =>
          rereadFormatCopies(zonedRegistry, settings, 'lifelabs-pdf', read)
        )
      )
    )

    // Assert
    const lifeLabsOf = (batchCopies: BatchCopies): object =>
      Option.getOrThrow(
        Arr.findFirst(batchCopies.formats, ({ format }) => format === 'lifelabs-pdf').pipe(
          Option.map(({ copies, notes, unreadableFiles }) => ({
            copies: copies.map(({ reviewKey }) => reviewKey),
            notes: notesOf(notes),
            unreadable: unreadableOf(unreadableFiles),
          }))
        )
      )
    expect({
      read: lifeLabsOf(read),
      inVancouver: lifeLabsOf(inVancouver),
      nowhere: lifeLabsOf(nowhere),
    }).toEqual({
      read: {
        copies: [
          '0:r.pdf/source-file/r.pdf',
          '0:r.pdf/patient',
          '2:s.pdf/source-file/s.pdf',
          '2:s.pdf/patient',
        ],
        notes: [
          ['0:r.pdf', ['read r.pdf in America/Toronto']],
          ['2:s.pdf', ['read s.pdf in America/Toronto']],
        ],
        unreadable: [],
      },
      inVancouver: {
        copies: [
          '0:r.pdf/source-file/r.pdf',
          '0:r.pdf/patient',
          '2:s.pdf/source-file/s.pdf',
          '2:s.pdf/patient',
        ],
        notes: [
          ['0:r.pdf', ['read r.pdf in America/Vancouver']],
          ['2:s.pdf', ['read s.pdf in America/Vancouver']],
        ],
        unreadable: [],
      },
      nowhere: {
        copies: [],
        notes: [],
        unreadable: [
          { title: 'r.pdf', error: 'ParseError' },
          { title: 's.pdf', error: 'ParseError' },
        ],
      },
    })
  })

  it('should pass every other format’s entry back as it was, in registry order, beside the unrecognized picks', async () => {
    // Arrange
    const picks = ['r.pdf', 'a.har', 'notes.txt'].map(pick)
    const read = await Effect.runPromise(
      readBatchCopies(zonedRegistry, settingsInZone('America/Toronto'), picks)
    )

    // Act
    const reread = await Effect.runPromise(
      rereadFormatCopies(zonedRegistry, settingsInZone('America/Vancouver'), 'lifelabs-pdf', read)
    )

    // Assert
    expect({
      formats: reread.formats.map(({ format }) => format),
      harIsAsRead: reread.formats[0] === read.formats[0],
      lifeLabsIsAsRead: reread.formats[1] === read.formats[1],
      unrecognizedIsAsRead: reread.unrecognizedFiles === read.unrecognizedFiles,
    }).toEqual({
      formats: ['har', 'lifelabs-pdf'],
      harIsAsRead: true,
      lifeLabsIsAsRead: false,
      unrecognizedIsAsRead: true,
    })
  })

  it('should give back the batch as read for a format that claimed nothing', async () => {
    // Arrange
    const read = await Effect.runPromise(
      readBatchCopies(zonedRegistry, defaultFormatSettings, [pick('a.har')])
    )

    // Act
    const reread = await Effect.runPromise(
      rereadFormatCopies(zonedRegistry, settingsInZone('America/Vancouver'), 'lifelabs-pdf', read)
    )

    // Assert
    expect(reread).toBe(read)
  })
})
