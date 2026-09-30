import { Either, Record } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  exerciseIdFromName,
  makePlan,
  outOfRangeFieldsOf,
  type PlanInput,
  type PlannedExercise,
  type PlannedExerciseField,
  type PlanProblem,
} from './plan.ts'
import { plannedArb, planInputArb } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

/** One way to push each field out of range, keeping the others valid. */
const breakField: {
  readonly [Field in PlannedExerciseField]: (planned: PlannedExercise) => PlannedExercise
} = {
  sets: (planned) => ({ ...planned, sets: 0 }),
  reps: (planned) => ({ ...planned, reps: 1.5 }),
  increment: (planned) => ({ ...planned, progression: { ...planned.progression, increment: 0 } }),
  failuresBeforeDeload: (planned) => ({
    ...planned,
    progression: { ...planned.progression, failuresBeforeDeload: 0 },
  }),
  deloadFraction: (planned) => ({
    ...planned,
    progression: { ...planned.progression, deloadFraction: 1 },
  }),
  minimumLoad: (planned) => ({
    ...planned,
    progression: { ...planned.progression, minimumLoad: -1 },
  }),
  loadStep: (planned) => ({ ...planned, progression: { ...planned.progression, loadStep: 0 } }),
}
const FIELDS = Record.keys(breakField)

describe('outOfRangeFieldsOf', () => {
  it('should find nothing wrong with a planned exercise in range', () => {
    fc.assert(
      fc.property(plannedArb, (planned) => {
        expect(outOfRangeFieldsOf(planned)).toEqual([])
      }),
      { numRuns: RUNS }
    )
  })

  it('should name exactly the field that was pushed out of range', () => {
    fc.assert(
      fc.property(plannedArb, fc.constantFrom(...FIELDS), (planned, field) => {
        expect(outOfRangeFieldsOf(breakField[field](planned))).toEqual([field])
      }),
      { numRuns: RUNS }
    )
  })
})

describe('makePlan', () => {
  it('should accept a valid input, keying each exercise by its id', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        // Act
        const plan = Either.getOrThrow(makePlan(input))

        // Assert
        expect(plan.title).toBe(input.title)
        expect(plan.workouts).toEqual(input.workouts)
        expect(Record.values(plan.exercisesById)).toEqual(input.exercises)
        for (const [exerciseId, planned] of Record.toEntries(plan.exercisesById)) {
          expect(planned.exercise.id).toBe(exerciseId)
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

  it('should refuse one exercise planned twice, naming it', () => {
    fc.assert(
      fc.property(planInputArb, (input) => {
        const [first] = input.exercises
        fc.pre(first !== undefined)
        expect(problemsOf({ ...input, exercises: [...input.exercises, first] })).toEqual([
          { _tag: 'ExerciseDuplicate', exerciseId: first.exercise.id },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse each workout exercise the plan does not run', () => {
    fc.assert(
      fc.property(planInputArb, fc.nat(), (input, seed) => {
        // Arrange
        const dropped = input.exercises[seed % input.exercises.length]
        fc.pre(dropped !== undefined)
        const exercises = input.exercises.filter((planned) => planned !== dropped)

        // Act
        const problems = problemsOf({ ...input, exercises })

        // Assert
        const expected = input.workouts
          .filter((workout) => workout.exerciseIds.includes(dropped.exercise.id))
          .map((workout) => ({
            _tag: 'WorkoutExerciseUnplanned',
            label: workout.label,
            exerciseId: dropped.exercise.id,
          }))
        expect(problems).toEqual(expected)
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a planned exercise out of range, naming the exercise and field', () => {
    fc.assert(
      fc.property(planInputArb, fc.constantFrom(...FIELDS), (input, field) => {
        const [first, ...rest] = input.exercises
        fc.pre(first !== undefined)
        expect(problemsOf({ ...input, exercises: [breakField[field](first), ...rest] })).toEqual([
          { _tag: 'ExerciseOutOfRange', exerciseId: first.exercise.id, field },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an exercise id that is not a slug, naming the entry', () => {
    fc.assert(
      fc.property(
        planInputArb,
        fc.constantFrom('', ' ', 'Bench Press', '-squat', 'squat--row', 'Squat'),
        (input, notSlug) => {
          // Arrange
          const [first, ...rest] = input.exercises
          fc.pre(first !== undefined)
          const renamed = { ...first, exercise: { ...first.exercise, id: notSlug } }
          const workouts = input.workouts.map((workout) => ({
            ...workout,
            exerciseIds: workout.exerciseIds.map((id) => (id === first.exercise.id ? notSlug : id)),
          }))

          // Act / Assert
          expect(problemsOf({ ...input, exercises: [renamed, ...rest], workouts })).toEqual([
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
        const [firstExercise, ...otherExercises] = input.exercises
        const [firstWorkout, ...otherWorkouts] = input.workouts
        fc.pre(firstExercise !== undefined && firstWorkout !== undefined)
        const unnamed = {
          ...firstExercise,
          exercise: { ...firstExercise.exercise, name: blank },
        }
        const idless = { ...firstExercise, exercise: { id: '', name: 'Idless' } }

        // Act
        const problems = problemsOf({
          ...input,
          exercises: [unnamed, ...otherExercises, idless],
          workouts: [{ ...firstWorkout, label: blank }, ...otherWorkouts],
        })

        // Assert
        expect(problems).toContainEqual({
          _tag: 'ExerciseUnnamed',
          exerciseId: firstExercise.exercise.id,
        })
        expect(problems).toContainEqual({
          _tag: 'ExerciseIdNotSlug',
          index: input.exercises.length,
        })
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

// Helpers

function problemsOf(input: PlanInput): readonly PlanProblem[] {
  return Either.match(makePlan(input), {
    onLeft: (invalid) => invalid.problems,
    onRight: () => [],
  })
}
