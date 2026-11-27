import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  copyOf,
  detached,
  plannedOf,
  stored,
  storedTyra,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import type * as ImportedCopy from './imported-copy.ts'
import * as KeptRecords from './kept-records.ts'
import * as RecordChoice from './record-choice.ts'
import * as ReferenceTable from './reference-table.ts'
import * as Suggestion from './suggestion.ts'

/**
 * Covers the kept records of an import: built whole from the records'
 * choices, in merge order whatever order the records come in, and one
 * record's choice at a time.
 */

/** A record of `copy` alone, bringing its resource as reviewed, with `choice` suggested for it. */
const incomingOf = (
  copy: ImportedCopy.Type,
  choice: Option.Option<RecordChoice.Type>
): KeptRecords.IncomingRecord =>
  KeptRecords.asReviewed(plannedOf([copy], Suggestion.make(choice, Suggestion.NoMatch())))

/** A copy of Tyra keyed by `value`, stating `gender`. */
const tyraStating = (
  value: string,
  gender: string,
  overrides: Partial<ImportedCopy.Type> = {}
): ImportedCopy.Type => copyOf(detached(tyraWire(value, { gender })), value, 'a.har', overrides)

const takingGender = Option.some(
  RecordChoice.MergeIntoExistingRecord({
    existing: storedTyra,
    fieldsTaken: HashSet.make('gender'),
  })
)

/** A reference table landing nothing, so no reference gains a link. */
const NO_LINKS = ReferenceTable.make({ logicalReferences: [], stageLiterals: [], sourceUrls: [] })

const genderOf = (resource: FhirResourceWithId): unknown =>
  resource.resourceType === 'Patient' ? resource.gender : null

describe('KeptRecords.fromRecordChoices', () => {
  it('should make each choice that merges into a stored record a merge into it, in order, and none for any other choice', () => {
    // Arrange
    const incomingRecords = [
      incomingOf(tyraStating('tyra', 'male'), takingGender),
      incomingOf(tyraStating('x', 'other'), Option.some(RecordChoice.SaveAsNewRecord())),
      incomingOf(tyraStating('y', 'other'), Option.none()),
      incomingOf(tyraStating('tyra-again', 'female'), takingGender),
    ]

    // Act
    const keptRecords = KeptRecords.fromRecordChoices(incomingRecords)

    // Assert
    expect({
      kept: Object.keys(keptRecords),
      gender: genderOf(KeptRecords.asMergedIn(keptRecords, storedTyra)),
      written: Option.map(
        KeptRecords.writeFor(KeptRecords.writesOf(NO_LINKS, keptRecords), storedTyra),
        literalReferenceOf
      ),
      untouched: KeptRecords.asMergedIn(keptRecords, stored({ ...tyraWire('tyra'), id: 'p-2' })).id,
    }).toEqual({
      kept: ['Patient/p-1'],
      gender: 'female',
      written: Option.some('Patient/p-1'),
      untouched: 'p-2',
    })
  })

  it('should merge a decoded record before an implied one, whatever order they come in', () => {
    // Arrange
    const implied = incomingOf(
      tyraStating('tyra-implied', 'male', { isImplied: true }),
      takingGender
    )
    const decoded = incomingOf(tyraStating('tyra', 'female'), takingGender)

    // Act
    const keptRecords = KeptRecords.fromRecordChoices([implied, decoded])

    // Assert
    expect(genderOf(KeptRecords.asMergedIn(keptRecords, storedTyra))).toBe('male')
  })
})

describe('KeptRecords.withRecordChoice', () => {
  it('should make a record’s merge after the merges already made, and leave the kept records as they are for a record that merges nothing', () => {
    // Arrange
    const first = incomingOf(tyraStating('tyra', 'male'), takingGender)
    const notMerging = incomingOf(tyraStating('x', 'other'), Option.some(RecordChoice.DontAdd()))
    const second = incomingOf(tyraStating('tyra-again', 'female'), takingGender)

    // Act
    const afterFirst = KeptRecords.withRecordChoice(KeptRecords.empty, first)
    const afterNotMerging = KeptRecords.withRecordChoice(afterFirst, notMerging)
    const afterSecond = KeptRecords.withRecordChoice(afterNotMerging, second)

    // Assert
    expect({
      afterFirst: genderOf(KeptRecords.asMergedIn(afterFirst, storedTyra)),
      unchanged: afterNotMerging === afterFirst,
      afterSecond: genderOf(KeptRecords.asMergedIn(afterSecond, storedTyra)),
      sameAsBuiltWhole: afterSecond,
    }).toEqual({
      afterFirst: 'male',
      unchanged: true,
      afterSecond: 'female',
      sameAsBuiltWhole: KeptRecords.fromRecordChoices([first, notMerging, second]),
    })
  })
})
