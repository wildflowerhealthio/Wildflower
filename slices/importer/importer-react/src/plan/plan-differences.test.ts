import {
  Difference,
  differencesInPlan,
  ExistingRecord,
  ImportPlan,
  PlannedRecord,
  RecordChoice,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { HashSet, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as PlanDifferences from './plan-differences.ts'
import {
  importedRecordOf,
  needingDecision,
  probableMatch,
  storedOf,
  tyraWire,
} from './plan.test-helpers.ts'

/** Tyra's Patient as `a.har` brings it, giving her a gender and a phone number. */
const tyra = importedRecordOf(
  tyraWire({
    identifier: [{ system: 'https://a.example/Patient', value: 'pat-7' }],
    gender: 'female',
    telecom: [{ system: 'phone', value: '555-0199' }],
  }),
  'Patient/pat-7'
)

/** A stored Tyra with another phone number and no gender. */
const withPhone = storedOf({
  ...tyraWire({ telecom: [{ system: 'phone', value: '555-0100' }] }),
  id: 's-1',
})

/** A stored Tyra with nothing but her name and birth date. */
const bare = storedOf({ ...tyraWire(), id: 's-2' })

/** A stored Tyra no search found, chosen for her anyway. */
const picked = storedOf({ ...tyraWire({ gender: 'female' }), id: 's-3' })

/** A plan of `records`, nothing stored of any external reference. */
const planOf = (...records: readonly PlannedRecord.Type[]): ImportPlan.Type =>
  ImportPlan.make(records, StoredMatch.empty)

describe('PlanDifferences.ofPlan', () => {
  it('compares a record that needs a decision with each record a search matched, then the one the reviewer chose', () => {
    // Arrange
    const planned = PlannedRecord.withChoice(
      needingDecision(tyra, [probableMatch(withPhone), probableMatch(bare)]),
      RecordChoice.mergeTakingNoField(picked)
    )
    const plan = planOf(planned)

    // Act
    const candidates = PlanDifferences.candidatesOf(PlanDifferences.ofPlan(plan), tyra.key)

    // Assert
    expect(candidates).toEqual([
      {
        existing: withPhone,
        knownBy: ExistingRecord.MatchedBySearch({ grade: 'probable', evidence: 'name' }),
        inPlan: differencesInPlan(plan, planned, withPhone),
      },
      {
        existing: bare,
        knownBy: ExistingRecord.MatchedBySearch({ grade: 'probable', evidence: 'name' }),
        inPlan: differencesInPlan(plan, planned, bare),
      },
      {
        existing: picked,
        knownBy: ExistingRecord.ChosenByReviewer(),
        inPlan: differencesInPlan(plan, planned, picked),
      },
    ])
    expect(candidates.map(({ inPlan }) => inPlan.differences)).toEqual([
      [Difference.FillsGap({ field: 'gender' }), Difference.Overwrites({ field: 'telecom' })],
      [Difference.FillsGap({ field: 'gender' }), Difference.FillsGap({ field: 'telecom' })],
      [Difference.FillsGap({ field: 'telecom' })],
    ])
  })

  it('compares no record that does not need a decision', () => {
    const planned = PlannedRecord.make({
      record: tyra,
      storedMatch: StoredMatch.makeEntry([probableMatch(withPhone)], Option.none()),
      suggestion: Suggestion.make(
        Option.some(RecordChoice.SaveAsNewRecord()),
        Suggestion.NameMatchNotReferenced()
      ),
    })

    const differences = PlanDifferences.ofPlan(planOf(planned))

    expect(PlanDifferences.candidatesOf(differences, tyra.key)).toEqual([])
  })
})

describe('PlanDifferences.ofPlan, two records into one existing record', () => {
  /** Tyra as `b.har` brings her off another server, giving her the same gender. */
  const tyraFromB = importedRecordOf(
    tyraWire({
      identifier: [{ system: 'https://b.example/Patient', value: 'tb-42' }],
      gender: 'female',
    }),
    'Patient/tb-42',
    'b.har'
  )

  /** The second record's differences from `bare`, once the first merges into it by `firstChoice`. */
  const secondDifferencesAfter = (firstChoice: RecordChoice.Type): readonly Difference.Type[] => {
    const plan = planOf(
      PlannedRecord.withChoice(needingDecision(tyra, [probableMatch(bare)]), firstChoice),
      needingDecision(tyraFromB, [probableMatch(bare)])
    )
    return Option.match(
      PlanDifferences.candidateOf(PlanDifferences.ofPlan(plan), tyraFromB.key, bare),
      { onNone: () => [], onSome: ({ inPlan }) => inPlan.differences }
    )
  }

  it("compares the second record with the existing record as the first one's merge leaves it", () => {
    expect([
      secondDifferencesAfter(RecordChoice.mergeTakingNoField(bare)),
      secondDifferencesAfter(
        RecordChoice.mergeTakingEveryField(bare, [Difference.FillsGap({ field: 'gender' })])
      ),
    ]).toEqual([[Difference.FillsGap({ field: 'gender' })], []])
  })
})

describe('PlanDifferences.candidateOf', () => {
  it('finds the candidate that is a stored record, and none for a record that is not one', () => {
    const differences = PlanDifferences.ofPlan(
      planOf(needingDecision(tyra, [probableMatch(withPhone)]))
    )

    expect([
      Option.map(
        PlanDifferences.candidateOf(differences, tyra.key, withPhone),
        ({ existing }) => existing
      ),
      PlanDifferences.candidateOf(differences, tyra.key, bare),
    ]).toEqual([Option.some(withPhone), Option.none()])
  })
})

describe('PlanDifferences.differingFieldsOf', () => {
  it('is every field a candidate differs on, once, in the order they first come', () => {
    const plan = planOf(needingDecision(tyra, [probableMatch(picked), probableMatch(withPhone)]))
    const candidates = PlanDifferences.candidatesOf(PlanDifferences.ofPlan(plan), tyra.key)

    expect(PlanDifferences.differingFieldsOf(candidates)).toEqual(['telecom', 'gender'])
  })
})

describe('PlanDifferences.sameIdentityFieldsOf', () => {
  it('keeps the identity fields no candidate differs on, and none without a candidate', () => {
    const plan = planOf(needingDecision(tyra, [probableMatch(picked), probableMatch(withPhone)]))
    const candidates = PlanDifferences.candidatesOf(PlanDifferences.ofPlan(plan), tyra.key)
    const stated = ['name', 'birthDate', 'gender']

    expect([
      PlanDifferences.sameIdentityFieldsOf(stated, candidates),
      PlanDifferences.sameIdentityFieldsOf(stated, []),
    ]).toEqual([['name', 'birthDate'], []])
  })
})

describe('PlanDifferences.fieldsTakenInto', () => {
  it('is the fields a merge into the stored record takes, and nothing for any other choice', () => {
    const fillingGaps = RecordChoice.mergeTakingEveryField(withPhone, [
      Difference.FillsGap({ field: 'gender' }),
    ])

    expect([
      PlanDifferences.fieldsTakenInto(Option.some(fillingGaps), withPhone),
      PlanDifferences.fieldsTakenInto(Option.some(fillingGaps), bare),
      PlanDifferences.fieldsTakenInto(Option.some(RecordChoice.DontAdd()), withPhone),
      PlanDifferences.fieldsTakenInto(Option.none(), withPhone),
    ]).toEqual([Option.some(HashSet.make('gender')), Option.none(), Option.none(), Option.none()])
  })
})

describe('PlanDifferences.takenAmong', () => {
  it('counts the differences whose field is taken', () => {
    const differences = [
      Difference.FillsGap({ field: 'gender' }),
      Difference.Overwrites({ field: 'telecom' }),
    ]

    expect([
      PlanDifferences.takenAmong(differences, HashSet.empty()),
      PlanDifferences.takenAmong(differences, HashSet.make('gender', 'address')),
      PlanDifferences.takenAmong(differences, HashSet.make('gender', 'telecom')),
    ]).toEqual([0, 1, 2])
  })
})

describe('PlanDifferences.takenShareOf', () => {
  const differences = [
    Difference.FillsGap({ field: 'gender' }),
    Difference.Overwrites({ field: 'telecom' }),
  ]

  it('says whether every difference, some or none is taken', () => {
    expect([
      PlanDifferences.takenShareOf(differences, HashSet.make('gender', 'telecom')),
      PlanDifferences.takenShareOf(differences, HashSet.make('gender')),
      PlanDifferences.takenShareOf(differences, HashSet.empty()),
    ]).toEqual([
      { share: 'Every', taken: 2, differing: 2 },
      { share: 'Some', taken: 1, differing: 2 },
      { share: 'None', taken: 0, differing: 2 },
    ])
  })

  it('decides over the current differences only, a field taken that no longer differs counting for nothing', () => {
    expect([
      PlanDifferences.takenShareOf(
        [Difference.FillsGap({ field: 'telecom' })],
        HashSet.make('gender', 'telecom')
      ),
      PlanDifferences.takenShareOf(
        [Difference.FillsGap({ field: 'telecom' })],
        HashSet.make('gender')
      ),
    ]).toEqual([
      { share: 'Every', taken: 1, differing: 1 },
      { share: 'None', taken: 0, differing: 1 },
    ])
  })
})

describe('PlanDifferences.differsOn', () => {
  it("is whether a field is one of the candidate's differences", () => {
    const plan = planOf(needingDecision(tyra, [probableMatch(withPhone)]))
    const [candidate] = PlanDifferences.candidatesOf(PlanDifferences.ofPlan(plan), tyra.key)

    expect(
      ['gender', 'telecom', 'birthDate'].map(
        (field) => candidate !== undefined && PlanDifferences.differsOn(candidate, field)
      )
    ).toEqual([true, true, false])
  })
})

describe('PlanDifferences.identifiersAddedBy', () => {
  it('is each identifier the imported record carries that the kept record lacks', () => {
    const carrying = storedOf({
      ...tyraWire({ identifier: [{ system: 'https://a.example/Patient', value: 'pat-7' }] }),
      id: 's-4',
    })
    const plan = planOf(needingDecision(tyra, [probableMatch(bare), probableMatch(carrying)]))
    const candidates = PlanDifferences.candidatesOf(PlanDifferences.ofPlan(plan), tyra.key)

    expect(
      candidates.map((candidate) =>
        PlanDifferences.identifiersAddedBy(candidate).map(({ system, value }) => ({
          system: String(system),
          value,
        }))
      )
    ).toEqual([[{ system: 'https://a.example/Patient', value: 'pat-7' }], []])
  })
})
