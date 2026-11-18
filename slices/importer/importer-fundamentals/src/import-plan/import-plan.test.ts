import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Equal, HashMap, HashSet, Option } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as FileCopy from './file-copy.ts'
import {
  candidate,
  copyOf,
  detached,
  drBrownWire,
  NAMES,
  OTHER_SOURCE,
  prescriptionWire,
  SOURCE,
  stored,
  tyraWire,
} from './import-plan.test-helpers.ts'
import * as ImportPlan from './import-plan.ts'
import * as PlanTotals from './plan-totals.ts'
import * as PlannedRecord from './planned-record.ts'
import * as RecordChoice from './record-choice.ts'
import * as RecordKey from './record-key.ts'
import * as StoredMatch from './stored-match.ts'

/**
 * Covers building the plan from file copies and a stored match, its derived
 * views and operations, and its totals.
 */

const tyraA = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra', 'a.har')
const tyraB = copyOf(detached(tyraWire('tyra')), 'tyra', 'b.pdf')
const prescription = copyOf(
  detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' })),
  'rx-1',
  'a.har'
)
const drBrown = copyOf(detached(drBrownWire), 'rx-1#implied', 'a.har', { isImplied: true })
const binary = (reviewKey: string): FileCopy.Type =>
  copyOf(detached({ resourceType: 'Binary', contentType: 'text/plain' }), reviewKey, 'a.har')

const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })
const storedBrown = stored({
  resourceType: 'Practitioner',
  id: 'pr-1',
  name: [{ family: 'Brown', given: ['Jonathan'] }],
})

const tyraKey = FileCopy.recordKeyOf(tyraA)
/** The key of the logical reference to Tyra by her key identifier, which the prescription's `subject` is. */
const TYRA_REFERENCE_KEY = LogicalReference.key(
  LogicalReference.make(
    'Patient',
    Option.getOrThrow(DetachedResource.keyIdentifierOf(tyraA.resource))
  )
)
const prescriptionKey = FileCopy.recordKeyOf(prescription)
const drBrownKey = FileCopy.recordKeyOf(drBrown)

/** A stored match giving each key its candidates, nothing else. */
const matchOf = (
  entries: readonly (readonly [RecordKey.Type, readonly ResourceMatch.Candidate[]])[]
): StoredMatch.Type => ({ ...StoredMatch.empty, candidatesByRecord: HashMap.fromIterable(entries) })

/** The sample import: Tyra from two files, a prescription, and the Dr. Brown it implies. */
const samplePlan = (): ImportPlan.Type =>
  ImportPlan.make(
    [tyraA, prescription, drBrown, tyraB],
    matchOf([
      [tyraKey, [candidate(storedTyra, 'certain', 'identifier')]],
      [drBrownKey, [candidate(storedBrown, 'probable', 'name')]],
    ])
  )

/** The record under `key`, which the test's plan holds. */
const recordOf = (plan: ImportPlan.Type, key: RecordKey.Type): PlannedRecord.Type =>
  Option.getOrThrow(ImportPlan.get(plan, key))

describe('ImportPlan.make', () => {
  it('should make one record of the copies two files bring under one key, the first copy first', () => {
    // Arrange / Act
    const plan = samplePlan()

    // Assert
    expect(
      plan.records.map(({ key, copies }) => ({
        key: RecordKey.match(key, { Keyed: () => 'keyed', Keyless: ({ reviewKey }) => reviewKey }),
        copies: copies.map(({ reviewKey }) => reviewKey),
      }))
    ).toEqual([
      { key: 'keyed', copies: ['a.har/tyra', 'b.pdf/tyra'] },
      { key: 'keyed', copies: ['a.har/rx-1'] },
      { key: 'keyed', copies: ['a.har/rx-1#implied'] },
    ])
  })

  it('should key each keyless record by its review key', () => {
    // Arrange / Act
    const plan = ImportPlan.make([binary('first'), binary('second')], StoredMatch.empty)

    // Assert
    expect(plan.records.map(({ key }) => key)).toEqual([
      RecordKey.Keyless({ reviewKey: 'a.har/first' }),
      RecordKey.Keyless({ reviewKey: 'a.har/second' }),
    ])
  })

  it('should suggest each record by its rule, Dr. Brown in Needs a decision with his one candidate', () => {
    // Arrange / Act
    const plan = samplePlan()

    // Assert
    expect(
      plan.records.map((planned) => ({
        reason: planned.suggestion.reason._tag,
        needsDecision: PlannedRecord.needsDecision(planned),
        label: PlannedRecord.labelOf(planned),
      }))
    ).toEqual([
      { reason: 'IdentifierMatchFieldsDiffer', needsDecision: false, label: 'Update' },
      { reason: 'NoMatch', needsDecision: false, label: 'Create' },
      { reason: 'NameMatchReferenced', needsDecision: true, label: 'LinkToExisting' },
    ])
  })

  it('should measure a second record using one stored record after the first takes its fields', () => {
    // Arrange
    const sharedStored = stored({
      ...tyraWire('tyra'),
      id: 'p-1',
      identifier: [
        { system: SOURCE, value: 'tyra' },
        { system: OTHER_SOURCE, value: 'tyra-at-other' },
      ],
    })
    const first = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra', 'a.har')
    const second = copyOf(
      detached(tyraWire('tyra-at-other', { gender: 'male' }, OTHER_SOURCE)),
      'tyra',
      'b.pdf'
    )
    const match = matchOf([
      [FileCopy.recordKeyOf(first), [candidate(sharedStored, 'certain', 'identifier')]],
      [FileCopy.recordKeyOf(second), [candidate(sharedStored, 'certain', 'identifier')]],
    ])

    // Act
    const plan = ImportPlan.make([first, second], match)

    // Assert
    expect(
      plan.records.map(({ suggestion }) => ({
        reason: suggestion.reason._tag,
        fieldsTaken: Option.map(suggestion.choice, (choice) =>
          RecordChoice.is('UseExistingRecord')(choice)
            ? [...HashSet.values(choice.fieldsTaken)]
            : []
        ),
      }))
    ).toEqual([
      { reason: 'IdentifierMatchFieldsDiffer', fieldsTaken: Option.some(['gender']) },
      { reason: 'IdentifierMatchFieldsDiffer', fieldsTaken: Option.some([]) },
    ])
  })

  it('should keep the stored candidates of each reference no record of the import resolves', () => {
    // Arrange
    const candidates = [candidate(storedTyra, 'certain', 'identifier')]

    // Act
    const plan = ImportPlan.make([prescription], {
      ...StoredMatch.empty,
      candidatesByUnresolvedReference: HashMap.make([TYRA_REFERENCE_KEY, candidates]),
    })

    // Assert
    expect(HashMap.get(plan.unresolvedReferences, TYRA_REFERENCE_KEY)).toEqual(
      Option.some(candidates)
    )
  })
})

describe('PlannedRecord and ImportPlan.choose', () => {
  it('should mark a record changed when the reviewer chooses other than the suggestion, and label it by the choice', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const chosen = ImportPlan.choose(plan, [prescriptionKey], RecordChoice.DontAdd())

    // Assert
    const planned = recordOf(chosen, prescriptionKey)
    expect({
      changed: PlannedRecord.isChanged(planned),
      label: PlannedRecord.labelOf(planned),
    }).toEqual({ changed: true, label: 'DontAdd' })
  })

  it('should not mark a record changed when the reviewer chooses what was suggested', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const chosen = ImportPlan.choose(plan, [prescriptionKey], RecordChoice.SaveAsNewRecord())

    // Assert
    expect(PlannedRecord.isChanged(recordOf(chosen, prescriptionKey))).toBe(false)
  })

  it('should label a linked record Update once it is edited', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const edited = ImportPlan.setEdit(plan, drBrownKey, Option.some(drBrown.resource))

    // Assert
    expect(PlannedRecord.labelOf(recordOf(edited, drBrownKey))).toBe('Update')
  })

  it('should label a record whose choice is undecided Open', () => {
    // Arrange
    const twoCandidates = ImportPlan.make(
      [prescription, drBrown],
      matchOf([
        [
          drBrownKey,
          [
            candidate(storedBrown, 'probable', 'name'),
            candidate({ ...storedBrown, id: 'pr-2' }, 'probable', 'name'),
          ],
        ],
      ])
    )

    // Act
    const label = PlannedRecord.labelOf(recordOf(twoCandidates, drBrownKey))

    // Assert
    expect(label).toBe('Open')
  })
})

describe('PlanTotals.of', () => {
  it('should count every record overall and each file set the records it brought', () => {
    // Arrange
    const plan = samplePlan()

    // Act
    const totals = PlanTotals.of(plan)

    // Assert
    expect({
      overall: totals.overall,
      fileSets: totals.fileSets.map(({ pickedFiles, counts }) => [pickedFiles[0].fileName, counts]),
    }).toEqual({
      overall: { records: 3, create: 1, update: 1, linkToExisting: 1, needsDecision: 1, open: 0 },
      fileSets: [
        [
          'a.har',
          { records: 3, create: 1, update: 1, linkToExisting: 1, needsDecision: 1, open: 0 },
        ],
        [
          'b.pdf',
          { records: 1, create: 0, update: 1, linkToExisting: 0, needsDecision: 0, open: 0 },
        ],
      ],
    })
  })
})

/** A reviewer's step: a choice for the record at `index`, or a reset of it by `null`. */
interface ReviewerStep {
  readonly index: number
  readonly choice: RecordChoice.Type | null
}

const reviewerStepArbitrary: fc.Arbitrary<ReviewerStep> = fc.record({
  index: fc.nat({ max: 2 }),
  choice: fc.option(
    fc.constantFrom(
      RecordChoice.SaveAsNewRecord(),
      RecordChoice.DontAdd(),
      RecordChoice.UseExistingRecord({ existing: storedTyra, fieldsTaken: HashSet.empty() }),
      RecordChoice.UseExistingRecord({ existing: storedTyra, fieldsTaken: HashSet.make('gender') })
    ),
    { nil: null }
  ),
})

/** `plan` after the reviewer's `steps`, each choosing for or resetting one record. */
const afterSteps = (plan: ImportPlan.Type, steps: readonly ReviewerStep[]): ImportPlan.Type =>
  steps.reduce((reviewed, { index, choice }) => {
    const keys = reviewed.records.slice(index, index + 1).map(({ key }) => key)
    return choice === null
      ? ImportPlan.reset(reviewed, keys)
      : ImportPlan.choose(reviewed, keys, choice)
  }, plan)

describe('ImportPlan properties', () => {
  it('should count every record once overall, whatever the reviewer chooses', () => {
    fc.assert(
      fc.property(fc.array(reviewerStepArbitrary), (steps) => {
        // Arrange
        const plan = afterSteps(samplePlan(), steps)

        // Act
        const { overall } = PlanTotals.of(plan)

        // Assert
        const notAdded = plan.records.filter(
          (planned) => PlannedRecord.labelOf(planned) === 'DontAdd'
        ).length
        expect(
          overall.create + overall.update + overall.linkToExisting + overall.open + notAdded
        ).toBe(overall.records)
        expect(overall.records).toBe(plan.records.length)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should restore every suggestion when each record is reset after the reviewer’s choices', () => {
    fc.assert(
      fc.property(fc.array(reviewerStepArbitrary), (steps) => {
        // Arrange
        const suggested = samplePlan()
        const reviewed = afterSteps(suggested, steps)

        // Act
        const reset = ImportPlan.reset(
          reviewed,
          reviewed.records.map(({ key }) => key)
        )

        // Assert
        expect(
          reset.records.every(
            (planned, index) =>
              Option.isNone(planned.chosen) &&
              !PlannedRecord.isChanged(planned) &&
              Equal.equals(planned.key, suggested.records[index]?.key) &&
              PlannedRecord.labelOf(planned) ===
                PlannedRecord.labelOf(suggested.records[index] ?? planned)
          )
        ).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})
