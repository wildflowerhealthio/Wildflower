import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  drBrown,
  plannedOf,
  samplePlan,
  stored,
  storedTyra,
  tyraA,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import * as ImportWrite from './import-write.ts'
import * as ImportedCopy from './imported-copy.ts'
import * as ImportedRecord from './imported-record.ts'
import * as PlanResolution from './plan-resolution.ts'
import type * as PlannedRecord from './planned-record.ts'
import * as Suggestion from './suggestion.ts'

/**
 * Covers the write over a resolved plan: blocked by the records with no
 * choice, ready with each written resource once in plan order, and nothing
 * to import.
 */

/** The sample plan's records resolved, each written as `writes` gives it by index. */
const resolutionOf = (
  records: readonly PlannedRecord.Type[],
  writes: readonly (FhirResourceWithId | null)[]
): PlanResolution.Type =>
  PlanResolution.make(
    records.map((planned, index) =>
      PlanResolution.makeRecord(
        { planned, id: Option.none(), resolved: ImportedRecord.resourceOf(planned.record) },
        Option.fromNullable(writes[index])
      )
    )
  )

/** `write`'s resources by literal reference, or how many records block it. */
const summaryOf = (write: ImportWrite.Type): unknown =>
  ImportWrite.match(write, {
    Ready: ({ resources }) => ({ ready: resources.map(literalReferenceOf) }),
    Blocked: ({ undecided }) => ({ blocked: undecided.length }),
  })

const newPrescription = stored({
  resourceType: 'MedicationRequest',
  id: 'rx-new',
  status: 'active',
  intent: 'order',
  medicationCodeableConcept: { text: 'Metformin' },
  subject: { reference: 'Patient/p-1' },
})
const tyraWithGender = stored({ ...tyraWire('tyra', { gender: 'female' }), id: 'p-1' })

describe('ImportWrite.of', () => {
  it('should block the write on every record with no choice, in plan order', () => {
    // Arrange
    const undecided = (copies: readonly ImportedCopy.Type[]): PlannedRecord.Type =>
      plannedOf(copies, { choice: Option.none(), reason: Suggestion.SeveralIdentifierMatches() })
    const [, prescriptionRecord] = samplePlan().records
    const records = [
      undecided([tyraA]),
      ...(prescriptionRecord === undefined ? [] : [prescriptionRecord]),
      undecided([drBrown]),
    ]

    // Act
    const write = ImportWrite.of(resolutionOf(records, [null, newPrescription]))

    // Assert
    expect(
      ImportWrite.match(write, {
        Ready: () => [],
        Blocked: ({ undecided: keys }) => keys,
      })
    ).toEqual([ImportedCopy.recordKeyOf(tyraA), ImportedCopy.recordKeyOf(drBrown)])
  })

  it('should write each resource once, in plan order, a stored record two records share once', () => {
    // Arrange
    const { records } = samplePlan()

    // Act
    const write = ImportWrite.of(
      resolutionOf(records, [tyraWithGender, newPrescription, tyraWithGender])
    )

    // Assert
    expect(summaryOf(write)).toEqual({ ready: ['Patient/p-1', 'MedicationRequest/rx-new'] })
  })

  it('should have nothing to import when no record has a write and none is undecided', () => {
    // Arrange
    const { records } = samplePlan()

    // Act
    const write = ImportWrite.of(resolutionOf(records, []))

    // Assert
    expect({ write: summaryOf(write), nothing: ImportWrite.isNothingToImport(write) }).toEqual({
      write: { ready: [] },
      nothing: true,
    })
  })

  it('should have something to import while any record is written', () => {
    // Arrange
    const { records } = samplePlan()

    // Act
    const write = ImportWrite.of(resolutionOf(records, [storedTyra]))

    // Assert
    expect(ImportWrite.isNothingToImport(write)).toBe(false)
  })
})
