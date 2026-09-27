import { Array as Arr, Either } from 'effect'
import * as fc from 'fast-check'
import { type ExerciseGoal, makePlan, type Plan, type Workout } from 'lifting-core'

/** A workout labelled `label` that leads with one of `exerciseIds` and runs a subset of the rest. */
const workoutArb = (exerciseIds: readonly string[], label: string): fc.Arbitrary<Workout> =>
  fc
    .tuple(fc.constantFrom(...exerciseIds), fc.shuffledSubarray([...exerciseIds]))
    .map(([leadId, otherIds]) => ({
      label,
      exerciseIds: Arr.dedupe(Arr.prepend(otherIds, leadId)),
    }))

/**
 * A plan the editor can show and save back unchanged, built by `makePlan`:
 * slug ids, trimmed names distinct regardless of case, loads a whole number
 * of 2.5 lb plates above the minimum, deload fractions in hundredths, and one
 * to three workouts with distinct labels, each running a non-empty ordered
 * subset of the exercises.
 *
 * @remarks
 * `lifting-core`'s own arbitraries are not exported, so this is the small
 * editor-shaped subset the React tests need.
 */
const editablePlanArb: fc.Arbitrary<Plan> = fc
  .uniqueArray(fc.stringMatching(/^[a-z]{1,8}(-[a-z]{1,8}){0,2}$/), {
    minLength: 1,
    maxLength: 5,
  })
  .chain((exerciseIds) =>
    fc.record({
      title: fc.stringMatching(/^[A-Za-z0-9](?:[A-Za-z0-9 ×]{0,18}[A-Za-z0-9])?$/),
      names: fc.uniqueArray(fc.stringMatching(/^[A-Z][a-z]{1,10}(?: [A-Z][a-z]{1,10})?$/), {
        minLength: exerciseIds.length,
        maxLength: exerciseIds.length,
        selector: (name) => name.toLowerCase(),
      }),
      prescriptions: fc.array(
        fc.record({
          platesAboveMinimum: fc.integer({ min: 0, max: 200 }),
          sets: fc.integer({ min: 1, max: 6 }),
          reps: fc.integer({ min: 1, max: 12 }),
          incrementLb: fc.constantFrom(2.5, 5, 10),
          failuresBeforeDeload: fc.integer({ min: 1, max: 5 }),
          deloadFraction: fc.integer({ min: 1, max: 99 }).map((percent) => percent / 100),
          minimumLoadLb: fc.constantFrom(0, 45),
          loadStepLb: fc.constantFrom(2.5, 5),
        }),
        { minLength: exerciseIds.length, maxLength: exerciseIds.length }
      ),
      workouts: fc
        .uniqueArray(fc.stringMatching(/^[A-Z][0-9]?$/), { minLength: 1, maxLength: 3 })
        .chain(([firstLabel, ...otherLabels]) =>
          fc
            .tuple(
              workoutArb(exerciseIds, firstLabel),
              fc.tuple(...otherLabels.map((label) => workoutArb(exerciseIds, label)))
            )
            .map(([firstWorkout, otherWorkouts]) => Arr.prepend(otherWorkouts, firstWorkout))
        ),
      exerciseIds: fc.constant(exerciseIds),
    })
  )
  .map((drawn): Plan => {
    const goals = Arr.zipWith(
      Arr.zip(drawn.exerciseIds, drawn.names),
      drawn.prescriptions,
      ([id, name], { platesAboveMinimum, sets, reps, ...progression }): ExerciseGoal => ({
        exercise: { id, name },
        loadLb: progression.minimumLoadLb + platesAboveMinimum * 2.5,
        sets,
        reps,
        progression,
      })
    )
    return Either.getOrThrow(makePlan({ title: drawn.title, goals, workouts: drawn.workouts }))
  })

export { editablePlanArb }
