import { Either, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { strongLifts5x5 } from 'lifting-core'
import { describe, expect, it } from 'vite-plus/test'

import {
  blankExerciseDraft,
  DraftPath,
  draftFromPlan,
  emptyPlanDraft,
  freshDraftKey,
  planFromDraft,
  type PlanDraft,
} from './plan-draft.ts'
import { editablePlanArb } from './test-arbitraries.ts'

describe('planFromDraft', () => {
  it('should decode the StrongLifts draft back to the same plan', () => {
    const plan = strongLifts5x5()

    const decoded = planFromDraft(draftFromPlan(plan))

    expect(decoded).toStrictEqual(Either.right(plan))
  })

  it('should decode any editable plan back to itself', () => {
    fc.assert(
      fc.property(editablePlanArb, (plan) => {
        expect(planFromDraft(draftFromPlan(plan))).toStrictEqual(Either.right(plan))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should never refuse a draft without naming at least one problem', () => {
    fc.assert(
      fc.property(messyDraftArb, (draft) => {
        Either.match(planFromDraft(draft), {
          onLeft: (problems) => {
            expect(problems.size).toBeGreaterThan(0)
          },
          onRight: () => undefined,
        })
      }),
      { numRuns: numRunsFor({ base: 200 }) }
    )
  })

  it('should give a new exercise the slug of its name, suffixed past a taken id', () => {
    // Arrange: rename the saved squat, then add a new exercise named "Squat".
    const draft = draftFromPlan(strongLifts5x5())
    const renamed: PlanDraft = {
      ...draft,
      exercises: [
        ...draft.exercises.map((exerciseDraft) =>
          exerciseDraft.key === 'squat' ? { ...exerciseDraft, name: 'Back Squat' } : exerciseDraft
        ),
        { ...blankExerciseDraft('exercise-6'), name: 'Squat', loadLb: '45' },
      ],
    }

    // Act
    const decoded = planFromDraft(renamed)

    // Assert
    const goals = Either.getOrThrow(decoded).goalsByExerciseId
    expect(goals['squat']?.exercise).toEqual({ id: 'squat', name: 'Back Squat' })
    expect(goals['squat-2']?.exercise).toEqual({ id: 'squat-2', name: 'Squat' })
  })

  it('should report every invalid field at once, keyed by its path', () => {
    const draft: PlanDraft = {
      title: '  ',
      exercises: [
        {
          ...blankExerciseDraft('exercise-1'),
          name: 'Squat',
          loadLb: '-5',
          sets: '2.5',
          reps: '0',
          incrementLb: 'five',
          failuresBeforeDeload: '',
          deloadPercent: '150',
          loadStepLb: '0',
        },
      ],
      workouts: [{ key: 'workout-1', label: 'A', exerciseKeys: [] }],
    }

    const problems = Either.getLeft(planFromDraft(draft)).pipe(Option.getOrThrow)

    expect([...problems.keys()].toSorted()).toEqual(
      [
        DraftPath.title,
        DraftPath.exercise('exercise-1', 'loadLb'),
        DraftPath.exercise('exercise-1', 'sets'),
        DraftPath.exercise('exercise-1', 'reps'),
        DraftPath.exercise('exercise-1', 'incrementLb'),
        DraftPath.exercise('exercise-1', 'failuresBeforeDeload'),
        DraftPath.exercise('exercise-1', 'deloadPercent'),
        DraftPath.exercise('exercise-1', 'loadStepLb'),
        DraftPath.workout('workout-1', 'exerciseKeys'),
      ].toSorted()
    )
  })

  it('should place duplicate workout labels and a missing workout under their fields', () => {
    const exercise = { ...blankExerciseDraft('exercise-1'), name: 'Squat', loadLb: '45' }
    const duplicateLabels: PlanDraft = {
      title: 'Mine',
      exercises: [exercise],
      workouts: [
        { key: 'workout-1', label: 'A', exerciseKeys: ['exercise-1'] },
        { key: 'workout-2', label: ' A ', exerciseKeys: ['exercise-1'] },
      ],
    }

    const problems = Either.getLeft(planFromDraft(duplicateLabels)).pipe(Option.getOrThrow)
    const noWorkouts = Either.getLeft(planFromDraft({ ...duplicateLabels, workouts: [] })).pipe(
      Option.getOrThrow
    )

    expect([...problems]).toEqual([
      [DraftPath.workout('workout-2', 'label'), 'Another workout already has this label'],
    ])
    expect(noWorkouts.get(DraftPath.workouts)).toBe('Add at least one workout')
  })

  it('should give two new exercises of the same name ids of their own', () => {
    const squat = { ...blankExerciseDraft('exercise-1'), name: 'Squat', loadLb: '45' }
    const draft: PlanDraft = {
      title: 'Mine',
      exercises: [squat, { ...squat, key: 'exercise-2' }],
      workouts: [{ key: 'workout-1', label: 'A', exerciseKeys: ['exercise-1', 'exercise-2'] }],
    }

    const plan = Either.getOrThrow(planFromDraft(draft))

    expect(plan.workouts[0].exerciseIds).toEqual(['squat', 'squat-2'])
  })

  it('should place a blank name, and a name with no letter or digit, under the name field', () => {
    const draft: PlanDraft = {
      ...emptyPlanDraft,
      title: 'Mine',
      exercises: [
        { ...blankExerciseDraft('exercise-1'), name: '???', loadLb: '45' },
        { ...blankExerciseDraft('exercise-2'), name: '  ', loadLb: '45' },
      ],
      workouts: [
        { key: 'workout-1', label: 'A', exerciseKeys: ['exercise-1', 'exercise-2'] },
        { key: 'workout-2', label: ' ', exerciseKeys: ['exercise-1'] },
      ],
    }

    const problems = Either.getLeft(planFromDraft(draft)).pipe(Option.getOrThrow)

    expect(problems.get(DraftPath.exercise('exercise-1', 'name'))).toBe(
      'Use letters, digits and hyphens'
    )
    expect(problems.get(DraftPath.exercise('exercise-2', 'name'))).toBe('Name the exercise')
    expect(problems.get(DraftPath.workout('workout-2', 'label'))).toBe('Label the workout')
  })
})

describe('freshDraftKey', () => {
  it('should never return a key already taken', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^exercise-[0-9]$/)), (takenKeys) => {
        expect(takenKeys).not.toContain(freshDraftKey('exercise', takenKeys))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** Field text a person might type: blank, valid, out of range, or not a number. */
const fieldTextArb = fc.constantFrom('', ' ', '0', '5', '45', '2.5', '-1', '100', 'abc')

/**
 * A draft as a person might leave it: blank, duplicate and slug-less names and
 * labels, ids an edited plan already has (repeated too), any field text, and
 * workouts naming any of the exercises — or none.
 */
const messyDraftArb: fc.Arbitrary<PlanDraft> = fc
  .array(
    fc.record({
      existingId: fc.constantFrom(Option.none(), Option.some('squat'), Option.some('bench-press')),
      name: fc.constantFrom('', '  ', 'Squat', 'squat ', '???', 'Bench Press'),
      loadLb: fieldTextArb,
      sets: fieldTextArb,
      reps: fieldTextArb,
      incrementLb: fieldTextArb,
      failuresBeforeDeload: fieldTextArb,
      deloadPercent: fieldTextArb,
      minimumLoadLb: fieldTextArb,
      loadStepLb: fieldTextArb,
    }),
    { maxLength: 4 }
  )
  .chain((exerciseFields) => {
    const exercises = exerciseFields.map((fields, index) => ({
      ...fields,
      key: `exercise-${index + 1}`,
    }))
    const exerciseKeys = exercises.map((exerciseDraft) => exerciseDraft.key)
    return fc.record({
      title: fc.constantFrom('', '  ', 'My plan'),
      exercises: fc.constant(exercises),
      workouts: fc
        .array(
          fc.record({
            label: fc.constantFrom('', ' ', 'A', 'A ', 'B'),
            exerciseKeys: fc.shuffledSubarray(exerciseKeys),
          }),
          { maxLength: 3 }
        )
        .map((workouts) =>
          workouts.map((workout, index) => ({ ...workout, key: `workout-${index + 1}` }))
        ),
    })
  })
