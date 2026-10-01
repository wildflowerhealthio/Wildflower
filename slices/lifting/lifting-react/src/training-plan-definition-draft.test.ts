import { Array as Arr, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { StrongLifts5x5 } from 'lifting-core'
import { someOrFail, trainingPlanDefinitionArb } from 'lifting-core/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import {
  type DayDraft,
  DraftPath,
  type DraftProblems,
  draftFromTrainingPlanDefinition,
  emptyDraft,
  type ExerciseDraft,
  type ExerciseTextField,
  newDayDraft,
  newExerciseDraft,
  type TrainingPlanDefinitionDraft,
  trainingPlanDefinitionFromDraft,
} from './training-plan-definition-draft.ts'

// Each case decodes a training plan definition, checking every exercise
// (definition)'s rule extension on every day, so properties run fewer
// iterations than one over a single value.
const RUNS = numRunsFor({ base: 30 })

describe('trainingPlanDefinitionFromDraft', () => {
  it('should make back the training plan definition any draft was made from', () => {
    fc.assert(
      fc.property(trainingPlanDefinitionArb, (trainingPlanDefinition) => {
        expect(
          trainingPlanDefinitionFromDraft({
            draft: draftFromTrainingPlanDefinition(trainingPlanDefinition),
            planDefinitionId: trainingPlanDefinition.id,
          })
        ).toStrictEqual(Either.right(trainingPlanDefinition))
      }),
      { numRuns: RUNS }
    )
  })

  it('should name a field that spells no number under that field alone', () => {
    fc.assert(
      fc.property(
        trainingPlanDefinitionArb,
        fc.nat(),
        fc.constantFrom<readonly Exclude<ExerciseTextField, 'name'>[]>(
          ['sets', 'reps', 'increment', 'failuresBeforeDeload'],
          ['deloadFraction', 'minimumLoad', 'loadStep']
        ),
        fc.constantFrom('', 'heavy', '5 lb'),
        (trainingPlanDefinition, rowSeed, fields, text) => {
          // Arrange: one row with each of `fields` blanked or worded.
          const draft = draftFromTrainingPlanDefinition(trainingPlanDefinition)
          const rows = draft.days.flatMap((dayDraft) =>
            dayDraft.exercises.map((exerciseDraft) => ({ dayDraft, exerciseDraft }))
          )
          const { dayDraft, exerciseDraft } = someOrFail(Arr.get(rows, rowSeed % rows.length))
          const edited = withRowPatched({
            draft,
            dayKey: dayDraft.key,
            exerciseKey: exerciseDraft.key,
            patch: Object.fromEntries(fields.map((field) => [field, text])),
          })

          // Act
          const problems = problemsOf(
            trainingPlanDefinitionFromDraft({ draft: edited, planDefinitionId: 'plan-1' })
          )

          // Assert
          expect(problems).toEqual(
            new Map(
              fields.map((field) => [
                DraftPath.exerciseField(exerciseDraft.key, field),
                'Enter a number',
              ])
            )
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse an empty draft for its title and its empty day', () => {
    expect(
      problemsOf(trainingPlanDefinitionFromDraft({ draft: emptyDraft, planDefinitionId: 'p' }))
    ).toEqual(
      new Map([
        [DraftPath.dayExercises('day-1'), 'Add at least one exercise to this day'],
        [DraftPath.title, 'Expected a non empty string, actual ""'],
      ])
    )
  })

  it('should refuse a draft with no day', () => {
    const problems = problemsOf(
      trainingPlanDefinitionFromDraft({
        draft: { title: 'Plan', days: [] },
        planDefinitionId: 'p',
      })
    )

    expect(problems).toEqual(new Map([[DraftPath.days, 'Add at least one day']]))
  })

  it("should put a progression rule's refusal under the field of the part it names", () => {
    const draft = withStrongLiftsRow(
      { dayIndex: 0, rowIndex: 1 },
      { deloadFraction: '1', loadStep: '0' }
    )

    const problems = problemsOf(trainingPlanDefinitionFromDraft({ draft, planDefinitionId: 'p' }))

    expect(problems).toEqual(
      new Map([
        [
          DraftPath.exerciseField('exercise-1-2', 'deloadFraction'),
          'Expected a number less than 1, actual 1',
        ],
        [
          DraftPath.exerciseField('exercise-1-2', 'loadStep'),
          'Expected a positive number, actual 0',
        ],
      ])
    )
  })

  it("should put an exercise (definition)'s refusal under its sets or reps", () => {
    const draft = withStrongLiftsRow({ dayIndex: 1, rowIndex: 2 }, { sets: '0', reps: '0' })

    const problems = problemsOf(trainingPlanDefinitionFromDraft({ draft, planDefinitionId: 'p' }))

    expect(problems).toEqual(
      new Map([
        [DraftPath.exerciseField('exercise-2-3', 'sets'), 'Expected a positive number, actual 0'],
        [DraftPath.exerciseField('exercise-2-3', 'reps'), 'Expected a positive number, actual 0'],
      ])
    )
  })

  it('should put a repeated day label under the later day, and an exercise defined two ways under the later row', () => {
    // Day B relabelled A, and its squat (row 1) cut to three sets.
    const draft = withStrongLiftsRow({ dayIndex: 1, rowIndex: 0 }, { sets: '3' })
    const relabelled = withDay({
      draft,
      dayKey: 'day-2',
      edit: (dayDraft) => ({ ...dayDraft, label: 'A' }),
    })

    const problems = problemsOf(
      trainingPlanDefinitionFromDraft({ draft: relabelled, planDefinitionId: 'p' })
    )

    expect([...problems.keys()]).toEqual([
      DraftPath.dayLabel('day-2'),
      DraftPath.exercise('exercise-2-1'),
    ])
  })

  it('should give a new row its name slug as its exercise id, and keep an existing id when renamed', () => {
    // The squat is on both days, so it is renamed on both.
    const renamed = withRowPatched({
      draft: withStrongLiftsRow({ dayIndex: 0, rowIndex: 0 }, { name: 'Back Squat' }),
      dayKey: 'day-2',
      exerciseKey: 'exercise-2-1',
      patch: { name: 'Back Squat' },
    })
    const newRow: ExerciseDraft = { ...newExerciseDraft(renamed), name: 'Front Squat' }
    const named = withDay({
      draft: renamed,
      dayKey: 'day-1',
      edit: (dayDraft) => ({ ...dayDraft, exercises: [...dayDraft.exercises, newRow] }),
    })

    const made = Either.getOrThrow(
      trainingPlanDefinitionFromDraft({ draft: named, planDefinitionId: 'p' })
    )

    expect(
      draftFromTrainingPlanDefinition(made).days[0]?.exercises.map(
        ({ existingExerciseId, name }) => [existingExerciseId, name]
      )
    ).toEqual([
      [Option.some('squat'), 'Back Squat'],
      [Option.some('bench-press'), 'Bench Press'],
      [Option.some('barbell-row'), 'Barbell Row'],
      [Option.some('front-squat'), 'Front Squat'],
    ])
  })
})

describe('the new rows', () => {
  it('should label a new day with the first letter no day has', () => {
    expect(
      [...strongLiftsDraft.days, newDayDraft(strongLiftsDraft)].map(({ label }) => label)
    ).toEqual(['A', 'B', 'C'])
  })

  it('should key a new day and a new exercise row apart from every row of the draft', () => {
    const takenKeys = strongLiftsDraft.days.flatMap((dayDraft) => [
      dayDraft.key,
      ...dayDraft.exercises.map(({ key }) => key),
    ])

    expect(takenKeys).not.toContain(newDayDraft(strongLiftsDraft).key)
    expect(takenKeys).not.toContain(newExerciseDraft(strongLiftsDraft).key)
  })
})

// Helpers

const strongLiftsDraft = draftFromTrainingPlanDefinition(
  StrongLifts5x5.trainingPlanDefinition('plan-1')
)

/** The problems of a refused draft; none when it was made. */
const problemsOf = <A>(made: Either.Either<A, DraftProblems>): DraftProblems =>
  Either.match(made, { onLeft: (problems) => problems, onRight: () => new Map() })

/** The `index`th day of a draft. */
const dayAt = (draft: TrainingPlanDefinitionDraft, index: number): DayDraft => {
  const dayDraft = draft.days[index]
  if (dayDraft === undefined) throw new Error(`no day ${index}`)
  return dayDraft
}

/** The draft with the day `dayKey` changed by `edit`. */
const withDay = ({
  draft,
  dayKey,
  edit,
}: {
  readonly draft: TrainingPlanDefinitionDraft
  readonly dayKey: string
  readonly edit: (dayDraft: DayDraft) => DayDraft
}): TrainingPlanDefinitionDraft => ({
  ...draft,
  days: draft.days.map((dayDraft) => (dayDraft.key === dayKey ? edit(dayDraft) : dayDraft)),
})

/** The draft with the row `exerciseKey` of the day `dayKey` patched. */
const withRowPatched = ({
  draft,
  dayKey,
  exerciseKey,
  patch,
}: {
  readonly draft: TrainingPlanDefinitionDraft
  readonly dayKey: string
  readonly exerciseKey: string
  readonly patch: Partial<Pick<ExerciseDraft, ExerciseTextField>>
}): TrainingPlanDefinitionDraft =>
  withDay({
    draft,
    dayKey,
    edit: (dayDraft) => ({
      ...dayDraft,
      exercises: dayDraft.exercises.map((exerciseDraft) =>
        exerciseDraft.key === exerciseKey ? { ...exerciseDraft, ...patch } : exerciseDraft
      ),
    }),
  })

/** The StrongLifts draft with one row patched. */
const withStrongLiftsRow = (
  { dayIndex, rowIndex }: { readonly dayIndex: number; readonly rowIndex: number },
  patch: Partial<Pick<ExerciseDraft, ExerciseTextField>>
): TrainingPlanDefinitionDraft => {
  const dayDraft = dayAt(strongLiftsDraft, dayIndex)
  const exerciseDraft = dayDraft.exercises[rowIndex]
  if (exerciseDraft === undefined) throw new Error(`no row ${rowIndex}`)
  return withRowPatched({
    draft: strongLiftsDraft,
    dayKey: dayDraft.key,
    exerciseKey: exerciseDraft.key,
    patch,
  })
}
