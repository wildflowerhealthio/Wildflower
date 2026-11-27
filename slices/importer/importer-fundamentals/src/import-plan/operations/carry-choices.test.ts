import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array as Arr, HashSet, Option } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import * as ImportPlan from '../entities/import-plan.ts'
import * as ImportedCopy from '../entities/imported-copy.ts'
import * as ImportedRecord from '../entities/imported-record.ts'
import * as PlannedRecord from '../entities/planned-record.ts'
import * as RecordChoice from '../entities/record-choice.ts'
import {
  candidate,
  copyOf,
  detached,
  drBrown,
  matchOf,
  OTHER_SOURCE,
  prescription,
  prescriptionWire,
  NAMES,
  SOURCE,
  stored,
  storedBrown,
  tyraWire,
} from '../import-plan.test-helpers.ts'
import { carryChoices } from './carry-choices.ts'
import { differencesInPlan } from './differences-in-plan.ts'
import { planOf } from './resolve-plan.test-helpers.ts'

/**
 * Covers the reviewer's choices carried from one plan of a batch onto a plan
 * of the same batch read again: only choices carry, by record key, a merge
 * keeping only the fields that still differ, in merge order.
 */

const THIRD_SOURCE = 'https://third.example/id'

/** The wire of one stored Tyra carrying every source's identifier, so a record keyed in any is her. */
const sharedTyraWire = {
  ...tyraWire('tyra'),
  id: 'p-1',
  identifier: [
    { system: SOURCE, value: 'tyra' },
    { system: OTHER_SOURCE, value: 'tyra-at-other' },
    { system: THIRD_SOURCE, value: 'tyra-at-third' },
  ],
}

/** The stored Tyra of {@link sharedTyraWire}. */
const sharedTyra = stored(sharedTyraWire)

/** Tyra from `a.har`, stating her gender as female. */
const first = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra', 'a.har')
/** {@link first} read again stating no gender. */
const firstWithoutGender = copyOf(detached(tyraWire('tyra')), 'tyra', 'a.har')

/**
 * Tyra a reference in `a.har` implies, keyed in the third source and stating
 * her gender as {@link first} does; first in plan order, last in merge order.
 */
const impliedTyra = copyOf(
  detached(tyraWire('tyra-at-third', { gender: 'female' }, THIRD_SOURCE)),
  'tyra#implied',
  'a.har',
  { isImplied: true }
)

/** Tyra from `b.pdf`, keyed in the other source and stating her gender as male. */
const second = copyOf(
  detached(tyraWire('tyra-at-other', { gender: 'male' }, OTHER_SOURCE)),
  'tyra',
  'b.pdf'
)
/** {@link second} read again stating her gender as female. */
const secondAsFemale = copyOf(
  detached(tyraWire('tyra-at-other', { gender: 'female' }, OTHER_SOURCE)),
  'tyra',
  'b.pdf'
)

/** {@link prescription} read again, stopped. */
const stoppedPrescription = copyOf(
  detached({
    ...prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' }),
    status: 'stopped',
  }),
  'rx-1',
  'a.har'
)

/** Each copy of the batch beside the copy a read under other settings may give for it instead. */
const COPIES_AND_REREAD: readonly (readonly [ImportedCopy.Type, ImportedCopy.Type])[] = [
  [impliedTyra, impliedTyra],
  [first, firstWithoutGender],
  [prescription, stoppedPrescription],
  [second, secondAsFemale],
  [drBrown, drBrown],
]

/** What the store holds of the batch: each Tyra by identifier as the shared Tyra, Dr. Brown by name. */
const MATCH = matchOf([
  ...[impliedTyra, first, second].map(
    (copy) =>
      [ImportedCopy.recordKeyOf(copy), [candidate(sharedTyra, 'certain', 'identifier')]] as const
  ),
  [ImportedCopy.recordKeyOf(drBrown), [candidate(storedBrown, 'probable', 'name')]],
])

/** The plan of `copies` as `planImport` suggests it against {@link MATCH}. */
const planOfCopies = (copies: readonly ImportedCopy.Type[]): ImportPlan.Type =>
  planOf(copies, MATCH)

/** A choice as text a test can compare whole: its tag, a merge's existing record and its fields in order. */
const choiceText = (choice: RecordChoice.Type): string =>
  RecordChoice.is('MergeIntoExistingRecord')(choice)
    ? `Merge into ${choice.existing.id} taking [${[...choice.fieldsTaken].toSorted().join(', ')}]`
    : choice._tag

/** Each record of `plan` by its first copy's review key beside the reviewer's choice as text, `null` for none. */
const reviewerChoicesOf = (plan: ImportPlan.Type): readonly (readonly [string, string | null])[] =>
  plan.records.map(({ record, chosen }) => [
    Arr.headNonEmpty(record.copies).reviewKey,
    Option.getOrNull(Option.map(chosen, choiceText)),
  ])

/** The record of `copy` in `plan`. */
const plannedOfCopy = (plan: ImportPlan.Type, copy: ImportedCopy.Type): PlannedRecord.Type =>
  Option.getOrThrow(ImportPlan.get(plan, ImportedCopy.recordKeyOf(copy)))

/** The fields `planned`, a record of `plan`, differs from `existing` on there. */
const differingFieldsOf = (
  plan: ImportPlan.Type,
  planned: PlannedRecord.Type,
  existing: FhirResourceWithId
): HashSet.HashSet<string> =>
  HashSet.fromIterable(
    differencesInPlan(plan, planned, existing).differences.map(({ field }) => field)
  )

const FIELDS = ['gender', 'birthDate', 'name', 'status'] as const

/** A choice a reviewer can make of any record, with any fields taken. */
const anyChoiceArbitrary: fc.Arbitrary<RecordChoice.Type> = fc.oneof(
  fc.constant(RecordChoice.SaveAsNewRecord()),
  fc.constant(RecordChoice.DontAdd()),
  fc
    .record({
      existing: fc.constantFrom(sharedTyra, storedBrown),
      fieldsTaken: fc.subarray([...FIELDS]),
    })
    .map(({ existing, fieldsTaken }) =>
      RecordChoice.MergeIntoExistingRecord({
        existing,
        fieldsTaken: HashSet.fromIterable(fieldsTaken),
      })
    )
)

/** The copies of a batch read again: each copy left out, kept, or read as its other copy. */
const rereadCopiesArbitrary: fc.Arbitrary<readonly ImportedCopy.Type[]> = fc
  .tuple(
    ...COPIES_AND_REREAD.map(([asRead, asReread]) =>
      fc.constantFrom<readonly ImportedCopy.Type[]>([], [asRead], [asReread])
    )
  )
  .map((copies) => copies.flat())

/** The batch's plan with the reviewer's choices, `null` for none, laid on its records in plan order. */
const reviewedPlanArbitrary: fc.Arbitrary<ImportPlan.Type> = fc
  .array(fc.option(anyChoiceArbitrary, { nil: null }), {
    minLength: COPIES_AND_REREAD.length,
    maxLength: COPIES_AND_REREAD.length,
  })
  .map((choices) => {
    const suggested = planOfCopies(COPIES_AND_REREAD.map(([asRead]) => asRead))
    return suggested.records.reduce(
      (reviewed, { record }, index) =>
        Option.match(Option.fromNullable(choices[index]), {
          onNone: () => reviewed,
          onSome: (choice) => ImportPlan.choose(reviewed, [record.key], choice),
        }),
      suggested
    )
  })

/** How a reviewer picks a record's choice from its differences: one of the choices a row or a card offers. */
type ConsistentPick = 'None' | 'SaveAsNew' | 'DontAdd' | 'FillGaps' | 'TakeEvery' | 'TakeNone'

/** `pick` made of `planned`, a record of `plan`, merging into `existing` by its differences there. */
const choiceOfPick = (
  plan: ImportPlan.Type,
  planned: PlannedRecord.Type,
  existing: FhirResourceWithId,
  pick: ConsistentPick
): Option.Option<RecordChoice.Type> => {
  const { differences } = differencesInPlan(plan, planned, existing)
  const choices: Record<ConsistentPick, Option.Option<RecordChoice.Type>> = {
    None: Option.none(),
    SaveAsNew: Option.some(RecordChoice.SaveAsNewRecord()),
    DontAdd: Option.some(RecordChoice.DontAdd()),
    FillGaps: Option.some(RecordChoice.mergeFillingGaps(existing, differences)),
    TakeEvery: Option.some(RecordChoice.mergeTakingEveryField(existing, differences)),
    TakeNone: Option.some(RecordChoice.mergeTakingNoField(existing)),
  }
  return choices[pick]
}

/**
 * The batch's plan with choices made as a reviewer makes them, in merge
 * order: each merge taking fields of its differences given the choices ahead
 * of it, so every merge's fields are a subset of its current differences.
 */
const consistentPlanArbitrary: fc.Arbitrary<ImportPlan.Type> = fc
  .array(
    fc.record({
      pick: fc.constantFrom<ConsistentPick>(
        'None',
        'SaveAsNew',
        'DontAdd',
        'FillGaps',
        'TakeEvery',
        'TakeNone'
      ),
      existing: fc.constantFrom(sharedTyra, storedBrown),
    }),
    { minLength: COPIES_AND_REREAD.length, maxLength: COPIES_AND_REREAD.length }
  )
  .map((picks) => {
    const suggested = planOfCopies(COPIES_AND_REREAD.map(([asRead]) => asRead))
    return ImportedRecord.inMergeOrder(suggested.records, ({ record }) => record).reduce(
      (reviewed, planned, index) => {
        const { pick, existing } = picks[index] ?? { pick: 'None', existing: sharedTyra }
        return Option.match(choiceOfPick(reviewed, planned, existing, pick), {
          onNone: () => reviewed,
          onSome: (choice) => ImportPlan.choose(reviewed, [planned.record.key], choice),
        })
      },
      suggested
    )
  })

/** Whether two records' suggestions are one: the same reason and an equivalent choice, or none. */
const sameSuggestion = (left: PlannedRecord.Type, right: PlannedRecord.Type): boolean =>
  left.suggestion.reason._tag === right.suggestion.reason._tag &&
  Option.getEquivalence(RecordChoice.equivalence)(left.suggestion.choice, right.suggestion.choice)

describe('carryChoices', () => {
  it('should carry a record’s Don’t add and a merge’s fields that still differ', () => {
    // Arrange
    const previous = ImportPlan.choose(
      ImportPlan.choose(
        planOfCopies([first, prescription]),
        [ImportedCopy.recordKeyOf(prescription)],
        RecordChoice.DontAdd()
      ),
      [ImportedCopy.recordKeyOf(first)],
      RecordChoice.MergeIntoExistingRecord({
        existing: sharedTyra,
        fieldsTaken: HashSet.make('gender'),
      })
    )

    // Act
    const { plan: carried } = carryChoices(previous, planOfCopies([first, stoppedPrescription]))

    // Assert
    expect(reviewerChoicesOf(carried)).toEqual([
      ['a.har/tyra', 'Merge into p-1 taking [gender]'],
      ['a.har/rx-1', 'DontAdd'],
    ])
  })

  it('should drop a merge’s field that no longer differs, so the update becomes a link', () => {
    // Arrange
    const previous = ImportPlan.choose(
      planOfCopies([first]),
      [ImportedCopy.recordKeyOf(first)],
      RecordChoice.MergeIntoExistingRecord({
        existing: sharedTyra,
        fieldsTaken: HashSet.make('gender'),
      })
    )

    // Act
    const { plan: carried } = carryChoices(previous, planOfCopies([firstWithoutGender]))

    // Assert
    const planned = plannedOfCopy(carried, firstWithoutGender)
    expect({
      choices: reviewerChoicesOf(carried),
      label: PlannedRecord.labelOf(planned),
    }).toEqual({
      choices: [['a.har/tyra', 'Merge into p-1 taking []']],
      label: 'LinkToExisting',
    })
  })

  it('should not carry a choice whose record the plan read again no longer has, name its key, and keep a new record’s suggestion', () => {
    // Arrange
    const previous = ImportPlan.choose(
      planOfCopies([first, prescription]),
      [ImportedCopy.recordKeyOf(prescription)],
      RecordChoice.DontAdd()
    )

    // Act
    const { plan: carried, notCarried } = carryChoices(previous, planOfCopies([first, second]))

    // Assert
    expect({ choices: reviewerChoicesOf(carried), notCarried }).toEqual({
      choices: [
        ['a.har/tyra', null],
        ['b.pdf/tyra', null],
      ],
      notCarried: [ImportedCopy.recordKeyOf(prescription)],
    })
  })

  it('should name a choice whose record’s key changed when read again, as a setting that changes its identifier does', () => {
    // Arrange — Tyra read again under another identifier: another record
    const tyraUnderOtherKey = copyOf(
      detached(tyraWire('tyra-under-another-card', { gender: 'female' })),
      'tyra',
      'a.har'
    )
    const previous = ImportPlan.choose(
      planOfCopies([first, prescription]),
      [ImportedCopy.recordKeyOf(first), ImportedCopy.recordKeyOf(prescription)],
      RecordChoice.DontAdd()
    )

    // Act
    const { plan: carried, notCarried } = carryChoices(
      previous,
      planOfCopies([tyraUnderOtherKey, prescription])
    )

    // Assert
    expect({ choices: reviewerChoicesOf(carried), notCarried }).toEqual({
      choices: [
        ['a.har/tyra', null],
        ['a.har/rx-1', 'DontAdd'],
      ],
      notCarried: [ImportedCopy.recordKeyOf(first)],
    })
  })

  it('should merge into the stored record as the plan read again found it, measuring its differences against it', () => {
    // Arrange — the shared Tyra stored again with the gender the import gives
    const sharedTyraNow = stored({ ...sharedTyraWire, gender: 'female' })
    const previous = ImportPlan.choose(
      planOfCopies([first]),
      [ImportedCopy.recordKeyOf(first)],
      RecordChoice.MergeIntoExistingRecord({
        existing: sharedTyra,
        fieldsTaken: HashSet.make('gender'),
      })
    )
    const next = planOf(
      [first],
      matchOf([
        [ImportedCopy.recordKeyOf(first), [candidate(sharedTyraNow, 'certain', 'identifier')]],
      ])
    )

    // Act
    const { plan: carried } = carryChoices(previous, next)

    // Assert — the fresh stored resource, its gender no longer a difference
    const chosen = plannedOfCopy(carried, first).chosen.pipe(
      Option.filter(RecordChoice.is('MergeIntoExistingRecord'))
    )
    expect({
      choice: Option.map(chosen, choiceText),
      isTheFreshResource: Option.exists(chosen, ({ existing }) => existing === sharedTyraNow),
    }).toEqual({ choice: Option.some('Merge into p-1 taking []'), isTheFreshResource: true })
  })

  it('should keep the reviewer’s own stored record when the plan read again does not list it', () => {
    // Arrange — a stored Tyra the reviewer picked by hand, no search lists
    const pickedByHand = stored({ ...tyraWire('tyra'), id: 'p-9' })
    const previous = ImportPlan.choose(
      planOfCopies([first]),
      [ImportedCopy.recordKeyOf(first)],
      RecordChoice.MergeIntoExistingRecord({
        existing: pickedByHand,
        fieldsTaken: HashSet.make('gender'),
      })
    )

    // Act
    const { plan: carried } = carryChoices(previous, planOfCopies([first]))

    // Assert — still hers, a ChosenByReviewer existing record, the gender still a gap it fills
    const planned = plannedOfCopy(carried, first)
    expect({
      choice: Option.map(planned.chosen, choiceText),
      knownBy: PlannedRecord.existingRecordsOf(planned).map(
        ({ resource, knownBy }) => [resource.id, knownBy._tag] as const
      ),
    }).toEqual({
      choice: Option.some('Merge into p-9 taking [gender]'),
      knownBy: [
        ['p-1', 'MatchedBySearch'],
        ['p-9', 'ChosenByReviewer'],
      ],
    })
  })

  it('should measure a merge after the choices ahead of it in merge order are carried', () => {
    // Arrange — the implied Tyra, ahead of the first in plan order and after
    // it in merge order, takes the gender the first, not added, leaves a gap
    // for; measured before the first's Don't add is carried, the first's
    // suggestion would have filled it with the same value
    const copies = [impliedTyra, first]
    const previous = [
      [first, RecordChoice.DontAdd()] as const,
      [
        impliedTyra,
        RecordChoice.MergeIntoExistingRecord({
          existing: sharedTyra,
          fieldsTaken: HashSet.make('gender'),
        }),
      ] as const,
    ].reduce(
      (plan, [copy, choice]) => ImportPlan.choose(plan, [ImportedCopy.recordKeyOf(copy)], choice),
      planOfCopies(copies)
    )

    // Act
    const { plan: carried } = carryChoices(previous, planOfCopies(copies))

    // Assert
    expect(reviewerChoicesOf(carried)).toEqual([
      ['a.har/tyra#implied', 'Merge into p-1 taking [gender]'],
      ['a.har/tyra', 'DontAdd'],
    ])
  })
})

describe('carryChoices properties', () => {
  it('should change nothing when a plan whose merges take only their differences is carried onto itself', () => {
    fc.assert(
      fc.property(consistentPlanArbitrary, (plan) => {
        // Act
        const { plan: carried } = carryChoices(plan, plan)

        // Assert
        expect(reviewerChoicesOf(carried)).toEqual(reviewerChoicesOf(plan))
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  it('should leave every carried merge taking only fields that differ in the carried plan', () => {
    fc.assert(
      fc.property(reviewedPlanArbitrary, rereadCopiesArbitrary, (previous, copies) => {
        // Act
        const { plan: carried } = carryChoices(previous, planOfCopies(copies))

        // Assert
        const fieldsNotDiffering = Arr.filterMap(carried.records, (planned) =>
          planned.chosen.pipe(
            Option.filter(RecordChoice.is('MergeIntoExistingRecord')),
            Option.map(({ existing, fieldsTaken }) => [
              ...HashSet.difference(fieldsTaken, differingFieldsOf(carried, planned, existing)),
            ])
          )
        ).flat()
        expect(fieldsNotDiffering).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  it('should keep the next plan’s records and suggestions, carry a choice only where the previous plan has one, and drop the rest', () => {
    fc.assert(
      fc.property(reviewedPlanArbitrary, rereadCopiesArbitrary, (previous, copies) => {
        // Arrange
        const next = planOfCopies(copies)

        // Act
        const { plan: carried, notCarried } = carryChoices(previous, next)

        // Assert
        expect(notCarried).toEqual(
          previous.records
            .filter(
              ({ record, chosen }) =>
                Option.isSome(chosen) && Option.isNone(ImportPlan.get(next, record.key))
            )
            .map(({ record }) => record.key)
        )
        const chosenInPrevious = (planned: PlannedRecord.Type): boolean =>
          Option.exists(ImportPlan.get(previous, planned.record.key), ({ chosen }) =>
            Option.isSome(chosen)
          )
        expect({
          records: carried.records.map(({ record, suggestion }) => ({
            key: record.key,
            suggestion,
          })),
          chosen: carried.records.map((planned) => Option.isSome(planned.chosen)),
        }).toEqual({
          records: next.records.map(({ record, suggestion }) => ({ key: record.key, suggestion })),
          chosen: next.records.map(chosenInPrevious),
        })
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  it('should keep whether each record is changed when the plan is carried onto the batch read again under the same settings', () => {
    fc.assert(
      fc.property(consistentPlanArbitrary, (plan) => {
        // Act
        const { plan: carried } = carryChoices(
          plan,
          planOfCopies(COPIES_AND_REREAD.map(([asRead]) => asRead))
        )

        // Assert
        expect(carried.records.map(PlannedRecord.isChanged)).toEqual(
          plan.records.map(PlannedRecord.isChanged)
        )
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  it('should keep whether a record is changed when its suggestion did not change and its choice is not a merge', () => {
    fc.assert(
      fc.property(reviewedPlanArbitrary, rereadCopiesArbitrary, (previous, copies) => {
        // Act
        const { plan: carried } = carryChoices(previous, planOfCopies(copies))

        // Assert
        const changedBeforeAndAfter = Arr.filterMap(carried.records, (planned) =>
          ImportPlan.get(previous, planned.record.key).pipe(
            Option.filter(
              (before) =>
                sameSuggestion(before, planned) &&
                !Option.exists(before.chosen, RecordChoice.is('MergeIntoExistingRecord'))
            ),
            Option.map((before) => [
              PlannedRecord.isChanged(before),
              PlannedRecord.isChanged(planned),
            ])
          )
        )
        expect(changedBeforeAndAfter.filter(([before, after]) => before !== after)).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})
