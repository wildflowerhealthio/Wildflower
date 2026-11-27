import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import {
  candidate,
  copyOf,
  detached,
  matchOf,
  OTHER_SOURCE,
  SOURCE,
  stored,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import { differencesInPlan, type DifferencesInPlan } from './differences-in-plan.ts'
import { FillsGap, Overwrites } from './differences-of/differences-of.ts'
import { planOf } from './resolve-plan.test-helpers.ts'

/**
 * Covers a planned record's differences from a record it could merge into,
 * after the merges of the records ahead of it in merge order, by their
 * effective choices.
 */

/** The differences of `copy`'s record in `plan` from `existing`. */
const differencesOfCopy = (
  plan: ImportPlan.Type,
  copy: ImportedCopy.Type,
  existing: FhirResourceWithId
): DifferencesInPlan =>
  differencesInPlan(
    plan,
    Option.getOrThrow(ImportPlan.get(plan, ImportedCopy.recordKeyOf(copy))),
    existing
  )

const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })

/** One stored Tyra carrying both sources' identifiers, so a record keyed in either is her. */
const sharedStored = stored({
  ...tyraWire('tyra'),
  id: 'p-1',
  identifier: [
    { system: SOURCE, value: 'tyra' },
    { system: OTHER_SOURCE, value: 'tyra-at-other' },
  ],
})

/** Tyra from `a.har`, stating her gender as female. */
const first = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra', 'a.har')

/** Tyra from `b.pdf`, keyed in the other source and stating her gender as male. */
const second = copyOf(
  detached(tyraWire('tyra-at-other', { gender: 'male' }, OTHER_SOURCE)),
  'tyra',
  'b.pdf'
)

/** The plan of `first` and `second`, both found by identifier as `sharedStored`. */
const twoRecordsIntoOne = (): ImportPlan.Type =>
  planOf(
    [first, second],
    matchOf([
      [ImportedCopy.recordKeyOf(first), [candidate(sharedStored, 'certain', 'identifier')]],
      [ImportedCopy.recordKeyOf(second), [candidate(sharedStored, 'certain', 'identifier')]],
    ])
  )

describe('differencesInPlan', () => {
  it('should give a field that fills a gap and one that overwrites for the record’s own suggested target, beside the two records compared', () => {
    // Arrange
    const tyra = copyOf(
      detached(tyraWire('tyra', { gender: 'female', birthDate: '1990-01-03' })),
      'tyra'
    )
    const plan = planOf(
      [tyra],
      matchOf([[ImportedCopy.recordKeyOf(tyra), [candidate(storedTyra, 'certain', 'identifier')]]])
    )

    // Act
    const { incoming, kept, differences } = differencesOfCopy(plan, tyra, storedTyra)

    // Assert
    expect({ incoming, kept, differences }).toEqual({
      incoming: tyra.resource,
      kept: storedTyra,
      differences: [Overwrites({ field: 'birthDate' }), FillsGap({ field: 'gender' })],
    })
  })

  it('should compare against a candidate that is not the record’s current choice', () => {
    // Arrange
    const tyra = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra')
    const plan = planOf([tyra])
    const candidateTyra = stored({ ...tyraWire('other'), id: 'p-9' })

    // Act
    const { differences } = differencesOfCopy(plan, tyra, candidateTyra)

    // Assert
    expect({
      choice: plan.records[0]?.suggestion.choice,
      differences,
    }).toEqual({
      choice: Option.some(RecordChoice.SaveAsNewRecord()),
      differences: [FillsGap({ field: 'gender' })],
    })
  })

  it('should measure a later record after an earlier one’s merge, and see the gap again once the earlier record is not added', () => {
    // Arrange
    const plan = twoRecordsIntoOne()
    const withFirstNotAdded = ImportPlan.choose(
      plan,
      [ImportedCopy.recordKeyOf(first)],
      RecordChoice.DontAdd()
    )

    // Act
    const [afterMerge, afterDontAdd] = [plan, withFirstNotAdded].map(
      (reviewed) => differencesOfCopy(reviewed, second, sharedStored).differences
    )

    // Assert
    expect({ afterMerge, afterDontAdd }).toEqual({
      afterMerge: [Overwrites({ field: 'gender' })],
      afterDontAdd: [FillsGap({ field: 'gender' })],
    })
  })

  it('should compare an edited record by its edit', () => {
    // Arrange
    const tyra = copyOf(detached(tyraWire('tyra')), 'tyra')
    const edit = detached(tyraWire('tyra', { birthDate: '1990-01-03' }))
    const plan = ImportPlan.setEdit(
      planOf(
        [tyra],
        matchOf([
          [ImportedCopy.recordKeyOf(tyra), [candidate(storedTyra, 'certain', 'identifier')]],
        ])
      ),
      ImportedCopy.recordKeyOf(tyra),
      Option.some(edit)
    )

    // Act
    const { incoming, differences } = differencesOfCopy(plan, tyra, storedTyra)

    // Assert
    expect({ incoming, differences }).toEqual({
      incoming: edit,
      differences: [Overwrites({ field: 'birthDate' })],
    })
  })

  it('should never let a record see its own merge or a later record’s', () => {
    // Arrange
    const plan = ImportPlan.choose(
      twoRecordsIntoOne(),
      [ImportedCopy.recordKeyOf(second)],
      RecordChoice.MergeIntoExistingRecord({
        existing: sharedStored,
        fieldsTaken: HashSet.make('gender'),
      })
    )

    // Act
    const { kept, differences } = differencesOfCopy(plan, first, sharedStored)

    // Assert
    expect({ kept, differences }).toEqual({
      kept: sharedStored,
      differences: [FillsGap({ field: 'gender' })],
    })
  })
})
