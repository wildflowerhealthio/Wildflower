import { PickedFile, PlannedRecord } from '@wildflowerhealthio/importer-fundamentals'
import { Effect, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { fileCopiesOf } from './file-copies-of.ts'
import { findStoredMatch, noStore } from './find-stored-match.ts'
import { importDecoded } from './import-decoded.ts'
import {
  decodedOf,
  derivedId,
  detached,
  PICKED_FILE,
  prescriptionWire,
  runAgainst,
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
    expect(
      result.records.map((planned) => ({
        reason: planned.suggestion.reason._tag,
        label: PlannedRecord.labelOf(planned),
      }))
    ).toEqual([
      { reason: 'IdentifierMatchSameAsExisting', label: 'LinkToExisting' },
      { reason: 'IdentifierMatchSameAsExisting', label: 'LinkToExisting' },
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
      reasons: result.records.map((planned) => planned.suggestion.reason._tag),
    }).toEqual({
      written: 4,
      reasons: Array.from({ length: 4 }, () => 'IdentifierMatchSameAsExisting'),
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
