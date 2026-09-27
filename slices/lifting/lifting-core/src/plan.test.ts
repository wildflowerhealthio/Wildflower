import { Either, Record } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  type ExerciseGoal,
  exerciseIdFromName,
  type GoalField,
  makePlan,
  outOfRangeFieldsOf,
  type PlanInput,
  type PlanProblem,
} from './plan.ts'
import { goalArb, planInputArb } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

/** One way to push each field out of range, keeping the others valid. */
const breakField: { readonly [Field in GoalField]: (goal: ExerciseGoal) => ExerciseGoal } = {
  loadLb: (goal) => ({ ...goal, loadLb: goal.progression.minimumLoadLb - 1 }),
  sets: (goal) => ({ ...goal, sets: 0 }),
  reps: (goal) => ({ ...goal, reps: 1.5 }),
  incrementLb: (goal) => ({ ...goal, progression: { ...goal.progression, incrementLb: 0 } }),
  failuresBeforeDeload: (goal) => ({
    ...goal,
    progression: { ...goal.progression, failuresBeforeDeload: 0 },
  }),
  deloadFraction: (goal) => ({ ...goal, progression: { ...goal.progression, deloadFraction: 1 } }),
  minimumLoadLb: (goal) => ({ ...goal, progression: { ...goal.progression, minimumLoadLb: -1 } }),
  loadStepLb: (goal) => ({ ...goal, progression: { ...goal.progression, loadStepLb: 0 } }),
}
const FIELDS = Record.keys(breakField)

describe('outOfRangeFieldsOf', () => {
  it('should find nothing wrong with a goal in range', () => {
    fc.assert(
      fc.property(goalArb, (goal) => {
        expect(outOfRangeFieldsOf(goal)).toEqual([])
      }),
      { numRuns: RUNS }
    )
  })

  it('should name exactly the field that was pushed out of range', () => {
    fc.assert(
      fc.property(goalArb, fc.constantFrom(...FIELDS), (goal, field) => {
        expect(outOfRangeFieldsOf(breakField[field](goal))).toEqual([field])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('makePlan', () => {
  it('should accept a valid input, keying each goal by its exercise id', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        // Act
        const plan = Either.getOrThrow(makePlan(input))

        // Assert
        expect(plan.title).toBe(input.title)
        expect(plan.workouts).toEqual(input.workouts)
        expect(Record.values(plan.goalsByExerciseId)).toEqual(input.goals)
        for (const [exerciseId, goal] of Record.toEntries(plan.goalsByExerciseId)) {
          expect(goal.exercise.id).toBe(exerciseId)
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an empty title', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        expect(problemsOf({ ...input, title: '' })).toEqual([{ _tag: 'TitleEmpty' }])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a plan with no workouts', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        expect(problemsOf({ ...input, workouts: [] })).toEqual([{ _tag: 'WorkoutsMissing' }])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a workout that runs no exercises, naming it', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        // Generated labels are one letter and a digit at most, so this one is new.
        const empty = { label: 'Empty', exerciseIds: [] }
        expect(problemsOf({ ...input, workouts: [...input.workouts, empty] })).toEqual([
          { _tag: 'WorkoutEmpty', label: 'Empty' },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse two workouts with one label, naming it', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const [first] = input.workouts
        fc.pre(first !== undefined)
        expect(problemsOf({ ...input, workouts: [...input.workouts, first] })).toEqual([
          { _tag: 'WorkoutLabelDuplicate', label: first.label },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse two goals for one exercise, naming it', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const [first] = input.goals
        fc.pre(first !== undefined)
        expect(problemsOf({ ...input, goals: [...input.goals, first] })).toEqual([
          { _tag: 'GoalDuplicate', exerciseId: first.exercise.id },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse each workout exercise left without a goal', () => {
    fc.assert(
      fc.property(planInputArb, fc.nat(), (input, seed) => {
        // Arrange
        const dropped = input.goals[seed % input.goals.length]
        fc.pre(dropped !== undefined)
        const goals = input.goals.filter((goal) => goal !== dropped)

        // Act
        const problems = problemsOf({ ...input, goals })

        // Assert
        const expected = input.workouts
          .filter((workout) => workout.exerciseIds.includes(dropped.exercise.id))
          .map((workout) => ({
            _tag: 'WorkoutExerciseWithoutGoal',
            label: workout.label,
            exerciseId: dropped.exercise.id,
          }))
        expect(problems).toEqual(expected)
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a goal out of range, naming the exercise and field', () => {
    fc.assert(
      fc.property(planInputArb, fc.constantFrom(...FIELDS), (input, field) => {
        const [first, ...rest] = input.goals
        fc.pre(first !== undefined)
        expect(problemsOf({ ...input, goals: [breakField[field](first), ...rest] })).toEqual([
          { _tag: 'GoalOutOfRange', exerciseId: first.exercise.id, field },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an exercise id that is not a slug, naming the goal', () => {
    fc.assert(
      fc.property(
        planInputArb,
        fc.constantFrom('', ' ', 'Bench Press', '-squat', 'squat--row', 'Squat'),
        (input, notSlug) => {
          // Arrange
          const [first, ...rest] = input.goals
          fc.pre(first !== undefined)
          const renamed = { ...first, exercise: { ...first.exercise, id: notSlug } }
          const workouts = input.workouts.map((workout) => ({
            ...workout,
            exerciseIds: workout.exerciseIds.map((id) => (id === first.exercise.id ? notSlug : id)),
          }))

          // Act / Assert
          expect(problemsOf({ ...input, goals: [renamed, ...rest], workouts })).toEqual([
            { _tag: 'ExerciseIdNotSlug', index: 0 },
          ])
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should name every problem in the error message', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const refused = Either.flip(makePlan({ ...input, title: '', workouts: [] }))
        expect(Either.map(refused, (invalid) => invalid.message)).toEqual(
          Either.right('plan refused: TitleEmpty; WorkoutsMissing')
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a blank workout label, a non-slug exercise id and a blank exercise name', () => {
    fc.assert(
      fc.property(planInputArb, fc.constantFrom('', ' ', '\t'), (input, blank) => {
        // Arrange
        const [firstGoal, ...otherGoals] = input.goals
        const [firstWorkout, ...otherWorkouts] = input.workouts
        fc.pre(firstGoal !== undefined && firstWorkout !== undefined)
        const unnamed = { ...firstGoal, exercise: { ...firstGoal.exercise, name: blank } }
        const idless = { ...firstGoal, exercise: { id: '', name: 'Idless' } }

        // Act
        const problems = problemsOf({
          ...input,
          goals: [unnamed, ...otherGoals, idless],
          workouts: [{ ...firstWorkout, label: blank }, ...otherWorkouts],
        })

        // Assert
        expect(problems).toContainEqual({
          _tag: 'ExerciseUnnamed',
          exerciseId: firstGoal.exercise.id,
        })
        expect(problems).toContainEqual({ _tag: 'ExerciseIdNotSlug', index: input.goals.length })
        expect(problems).toContainEqual({ _tag: 'WorkoutUnlabelled', index: 0 })
      }),
      { numRuns: RUNS }
    )
  })

  it('should report every problem at once', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const tags = problemsOf({ ...input, title: '', workouts: [] }).map(
          (problem) => problem._tag
        )
        expect(tags).toEqual(['TitleEmpty', 'WorkoutsMissing'])
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

function problemsOf(input: PlanInput): readonly PlanProblem[] {
  return Either.match(makePlan(input), {
    onLeft: (invalid) => invalid.problems,
    onRight: () => [],
  })
}

describe('exerciseIdFromName', () => {
  it('should slug display names the way exercise ids are spelled', () => {
    expect(exerciseIdFromName('Bench Press')).toBe('bench-press')
    expect(exerciseIdFromName('  Développé  Couché! ')).toBe('developpe-couche')
    expect(exerciseIdFromName('Romanian Deadlift (RDL)')).toBe('romanian-deadlift-rdl')
  })

  it('should produce only lowercase letters, digits and single inner hyphens', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (name) => {
        expect(exerciseIdFromName(name)).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/)
      }),
      { numRuns: RUNS }
    )
  })

  it('should leave its own output unchanged', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (name) => {
        const id = exerciseIdFromName(name)
        expect(exerciseIdFromName(id)).toBe(id)
      }),
      { numRuns: RUNS }
    )
  })
})
