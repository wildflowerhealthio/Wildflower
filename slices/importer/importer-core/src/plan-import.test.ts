import {
  DecodedFileSet,
  differencesInPlan,
  type FileSetRecord,
  type FormatDecode,
  type ImportPlan,
  ImportedRecord,
  locateReferences,
  PickedFile,
  PlannedRecord,
  RecordChoice,
  RecordReferences,
  Section,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { fileCopiesOf } from './file-copies-of.ts'
import { findStoredMatch, noStore } from './find-stored-match.ts'
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

/**
 * Covers building an import's plan: its copies grouped into records, matched
 * once against the store the caller names, and suggested.
 */

/**
 * Each record of `plan` as its reason, and its differences from the
 * existing record its effective choice merges it into (`differencesInPlan`);
 * `None` for a record that merges into none.
 */
const reasonsAndDifferencesOf = (plan: ImportPlan.Type): readonly unknown[] =>
  plan.records.map((planned) => ({
    reason: planned.suggestion.reason._tag,
    differences: Option.map(
      Option.filter(
        PlannedRecord.effectiveChoice(planned),
        RecordChoice.is('MergeIntoExistingRecord')
      ),
      ({ existing }) => differencesInPlan(plan, planned, existing).differences
    ),
  }))

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
    const { result } = await runAgainst(planImport(copies, findStoredMatch), [
      storedSourceFile,
      storedTyra,
    ])

    // Assert
    expect({
      labels: result.records.map(PlannedRecord.labelOf),
      records: reasonsAndDifferencesOf(result),
    }).toEqual({
      labels: ['LinkToExisting', 'LinkToExisting'],
      records: Array.from({ length: 2 }, () => ({
        reason: 'OneIdentifierMatch',
        differences: Option.some([]),
      })),
    })
  })

  it('should plan one Binary record, not two, when two file sets bring the same DocumentReference and the same Binary at one URL', async () => {
    // Arrange
    const { copies } = await Effect.runPromise(
      fileCopiesOf({ sourceFileFormat }, twoCapturesOfOneBinary())
    )

    // Act
    const { result } = await runAgainst(planImport(copies, findStoredMatch), [])

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
    const { result } = await runAgainst(planImport(copies, findStoredMatch), [])

    // Assert
    const records = result.records.map(({ record }) => record)
    const references = locateReferences(records)
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
    const { result } = await runAgainst(planImport(copies, findStoredMatch), written)

    // Assert
    expect({
      written: written.length,
      records: reasonsAndDifferencesOf(result),
    }).toEqual({
      written: 4,
      records: Array.from({ length: 4 }, () => ({
        reason: 'OneIdentifierMatch',
        differences: Option.some([]),
      })),
    })
  })

  it('should suggest saving every record as new with no store, sending nothing', async () => {
    // Arrange
    const { copies } = await Effect.runPromise(
      fileCopiesOf(
        { sourceFileFormat },
        decodedOf([
          ['tyra', detached(tyraWire)],
          ['rx-1', detached(prescriptionWire)],
        ])
      )
    )

    // Act
    const { result, requests } = await runAgainst(planImport(copies, noStore), [])

    // Assert
    expect({
      requests,
      reasons: result.records.map((planned) => planned.suggestion.reason._tag),
    }).toEqual({ requests: [], reasons: Array.from({ length: 4 }, () => 'NoMatch') })
  })
})
