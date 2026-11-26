import {
  DecodedFileSet,
  type FileSetRecord,
  type FormatDecode,
  ImportedRecord,
  PickedFile,
  PlannedRecord,
  RecordReferences,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { fileCopiesOf } from './file-copies-of.ts'
import { importDecoded } from './import-decoded.ts'
import {
  decodedOf,
  derivedId,
  detached,
  observationWire,
  PICKED_FILE,
  prescriptionWire,
  runAgainst,
  SOURCE,
  sourceFileFormat,
  stored,
  tyraWire,
} from './plan-import.test-helpers.ts'
import { planImport } from './plan-import.ts'
import * as ReviewGroup from './review-group.ts'

/** Covers building an import's plan: its copies grouped into records, matched once, and suggested. */

const BINARY_URL = new URL('https://fhir.example/r4/Binary/report-1')

/** One file set of the test format: `fileName`'s records under their local keys. */
interface TestFileSet {
  readonly fileName: string
  readonly records: readonly FileSetRecord.Type[]
}

/** A decode of the test format holding `fileSets`, each from one picked file of its own bytes. */
const decodedOfFileSets = (fileSets: readonly TestFileSet[]): FormatDecode.Decoded<string> => {
  const pickedFiles = fileSets.map(({ fileName }, index): PickedFile.Type => ({
    id: `${index + 1}:${fileName}`,
    fileName,
    bytes: new Uint8Array([index + 1]),
  }))
  return {
    format: 'test',
    files: pickedFiles,
    fileSets: Arr.zipWith(
      pickedFiles,
      fileSets,
      (pickedFile, { records }): DecodedFileSet.Type => ({
        pickedFiles: [DecodedFileSet.unidentified(pickedFile)],
        sectionedList: SectionedList.make([Section.make('records', records)]),
        notes: [],
      })
    ),
    unreadableFiles: [],
  }
}

/** A record of a test file set under `localKey`, served at no URL. */
const recordOf = (localKey: string, fields: object): FileSetRecord.Type => ({
  localKey,
  resource: detached(fields),
  sourceUrl: Option.none(),
})

/**
 * A decode of two file sets, two captures of one portal: each holds the
 * same DocumentReference, keyed by its identifier, naming the same Binary
 * by the URL the portal served it at.
 */
const twoCapturesOfOneBinary = (): FormatDecode.Decoded<string> => {
  const capture = (fileName: string): TestFileSet => ({
    fileName,
    records: [
      recordOf('report', {
        resourceType: 'DocumentReference',
        identifier: [{ system: SOURCE, value: 'report-1' }],
        status: 'current',
        content: [{ attachment: { contentType: 'application/pdf', url: BINARY_URL.href } }],
      }),
      {
        ...recordOf('binary', { resourceType: 'Binary', contentType: 'application/pdf' }),
        sourceUrl: Option.some(BINARY_URL),
      },
    ],
  })
  return decodedOfFileSets([capture('first.test'), capture('second.test')])
}

const HCN = { system: 'https://health-card.example/hcn', value: '3648223849' }

/**
 * A decode of an EHR file holding Tyra, keyed in its source's system and
 * carrying her health card number, and a lab file holding only an
 * Observation naming her by that number, which implies a Patient keyed by
 * it.
 */
const ehrAndLabFile = (): FormatDecode.Decoded<string> =>
  decodedOfFileSets([
    {
      fileName: 'ehr.test',
      records: [recordOf('tyra', { ...tyraWire, identifier: [...tyraWire.identifier, HCN] })],
    },
    {
      fileName: 'lab.test',
      records: [
        recordOf('a1c-1', {
          ...observationWire,
          subject: { type: 'Patient', identifier: HCN, display: 'Tyra Ashford' },
        }),
      ],
    },
  ])

describe('planImport', () => {
  it('should find a re-imported source file and record the same as existing under their derived ids', async () => {
    // Arrange
    const { copies } = await Effect.runPromise(
      fileCopiesOf({ sourceFileFormat }, decodedOf([['tyra', detached(tyraWire)]]))
    )
    const storedSourceFile = await Effect.runPromise(
      Schema.encode(PickedFile.FromDocumentReference)(PICKED_FILE).pipe(
        Effect.provideService(PickedFile.Format, sourceFileFormat)
      )
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
      { reason: 'OneIdentifierMatch', label: 'LinkToExisting' },
      { reason: 'OneIdentifierMatch', label: 'LinkToExisting' },
    ])
  })

  it('should plan one Binary record, not two, when two file sets bring the same DocumentReference and the same Binary at one URL', async () => {
    // Arrange
    const { copies } = await Effect.runPromise(
      fileCopiesOf({ sourceFileFormat }, twoCapturesOfOneBinary())
    )

    // Act
    const { result } = await runAgainst(planImport(copies), [])

    // Assert
    expect(
      result.records.map(({ record }) => ({
        resourceType: record.copies[0].resource.resourceType,
        copies: record.copies.map(({ reviewKey }) => reviewKey),
      }))
    ).toEqual([
      { resourceType: 'DocumentReference', copies: ['1:first.test/source-file/first.test'] },
      {
        resourceType: 'DocumentReference',
        copies: ['1:first.test/report', '2:second.test/report'],
      },
      { resourceType: 'Binary', copies: ['1:first.test/binary', '2:second.test/binary'] },
      { resourceType: 'DocumentReference', copies: ['2:second.test/source-file/second.test'] },
    ])
  })

  it('should reference the EHR file’s Patient carrying a health card number, not the Patient the lab file’s reference to it implied', async () => {
    // Arrange
    const { copies } = await Effect.runPromise(fileCopiesOf({ sourceFileFormat }, ehrAndLabFile()))

    // Act
    const { result } = await runAgainst(planImport(copies), [])

    // Assert
    const records = result.records.map(({ record }) => record)
    const references = RecordReferences.of(records)
    expect(
      records
        .filter(({ copies: [first] }) => first.resource.resourceType === 'Patient')
        .map((record) => ({
          isImplied: ImportedRecord.isImplied(record),
          isReferenced: RecordReferences.isReferenced(references, record.key),
        }))
    ).toEqual([
      { isImplied: false, isReferenced: true },
      { isImplied: true, isReferenced: false },
    ])
  })

  it('should find everything the current import stage wrote the same as existing on a re-import, references and all', async () => {
    // Arrange
    const decoded = decodedOf([
      ['tyra', detached(tyraWire)],
      ['rx-1', detached(prescriptionWire)],
    ])
    const firstImport = await Effect.runPromise(importDecoded({ sourceFileFormat }, decoded))
    const written = ReviewGroup.rows(firstImport).map(({ resource }) => resource)
    const { copies } = await Effect.runPromise(fileCopiesOf({ sourceFileFormat }, decoded))

    // Act
    const { result } = await runAgainst(planImport(copies), written)

    // Assert
    expect({
      written: written.length,
      reasons: result.records.map((planned) => planned.suggestion.reason._tag),
    }).toEqual({
      written: 4,
      reasons: Array.from({ length: 4 }, () => 'OneIdentifierMatch'),
    })
  })
})
