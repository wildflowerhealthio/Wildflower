import { DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { WildflowerExtension } from 'fhir-r4/data-types'
import { PlanDefinition } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { strongLifts5x5 } from '../strong-lifts.ts'
import { smallPlanArb } from '../test-helpers.ts'
import { LiftingMeasureCode, LiftingProgressionPart, planUrlOf } from './elements.ts'
import { type PlanDefinitionResource, planFromFhir, planToFhir } from './plan.ts'
import { foreignConceptArb, problemsOf, throughWire } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

// Encode → JSON → decode of a whole PlanDefinition is the slow path, so the
// wire round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 30 })

const options = { planDefinitionId: 'plan-1', date: DateTime.unsafeMake('2026-01-01T00:00:00Z') }

/** A decoded PlanDefinition carrying nothing lifting-specific, for generated fields to be spread onto. */
const shell: PlanDefinitionResource = Schema.decodeUnknownSync(PlanDefinition.Schema)({
  resourceType: 'PlanDefinition',
  id: 'foreign',
  status: 'active',
  title: 'Cardiac rehab',
})

describe('planToFhir / planFromFhir', () => {
  it('should write StrongLifts as an active PlanDefinition of two workout actions', () => {
    // Act
    const wire = Schema.encodeSync(PlanDefinition.Schema)(planToFhir(strongLifts5x5(), options))

    // Assert
    expect(wire.status).toBe('active')
    expect(wire.id).toBe('plan-1')
    expect(wire.url).toBe(planUrlOf('plan-1'))
    expect(wire.title).toBe('StrongLifts 5×5')
    expect(wire.date).toBe('2026-01-01T00:00:00.000Z')
    expect(wire.topic).toMatchObject([{ coding: [{ code: 'strength-training' }] }])
    expect(wire.action?.map((workout) => workout.title)).toEqual(['A', 'B'])
    expect(
      wire.action?.map((workout) =>
        workout.action?.map((exercise) => exercise.code?.[0]?.coding?.[0]?.code)
      )
    ).toEqual([
      ['squat', 'bench-press', 'barbell-row'],
      ['squat', 'overhead-press', 'deadlift'],
    ])
    const squat = wire.action?.[0]?.action?.[0]
    expect(squat?.title).toBe('Squat')
    expect(
      squat?.code
        ?.slice(1)
        .map((concept) => [
          concept.coding?.[0]?.code,
          concept.extension?.[0]?.url,
          concept.extension?.[0]?.valueInteger,
        ])
    ).toEqual([
      [LiftingMeasureCode.Sets, WildflowerExtension.LiftingMeasureValue, 5],
      [LiftingMeasureCode.Reps, WildflowerExtension.LiftingMeasureValue, 5],
    ])
    expect(squat?.extension?.[0]?.url).toBe(WildflowerExtension.LiftingProgression)
    expect(
      squat?.extension?.[0]?.extension?.map((part) => [
        part.url,
        part.valueString ?? part.valueInteger ?? part.valueDecimal,
      ])
    ).toEqual([
      [LiftingProgressionPart.Unit, 'lb'],
      [LiftingProgressionPart.Increment, 5],
      [LiftingProgressionPart.FailuresBeforeDeload, 3],
      [LiftingProgressionPart.DeloadFraction, 0.1],
      [LiftingProgressionPart.MinimumLoad, 45],
      [LiftingProgressionPart.LoadStep, 5],
    ])
  })

  it('should read back every plan it writes, with its id and url, through the encoded wire form', () => {
    fc.assert(
      fc.property(smallPlanArb, (plan) => {
        const read = planFromFhir(throughWire(PlanDefinition.Schema, planToFhir(plan, options)))
        expect(read).toEqual(
          Either.right({ plan, planDefinitionId: 'plan-1', url: planUrlOf('plan-1') })
        )
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should refuse a definition with no id or no url, naming each', () => {
    fc.assert(
      fc.property(smallPlanArb, fc.boolean(), fc.boolean(), (plan, idless, urlless) => {
        const written = planToFhir(plan, options)
        const edited = {
          ...written,
          id: idless ? null : written.id,
          url: urlless ? null : written.url,
        }
        expect(problemsOf(planFromFhir(edited))).toEqual([
          ...(idless ? [{ _tag: 'PlanDefinitionIdMissing' }] : []),
          ...(urlless ? [{ _tag: 'UrlMissing' }] : []),
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a workout action without a title, naming it', () => {
    fc.assert(
      fc.property(smallPlanArb, fc.nat(), (plan, seed) => {
        // Arrange
        const written = planToFhir(plan, options)
        const index = seed % written.action.length
        const edited = {
          ...written,
          action: written.action.map((workout, at) =>
            at === index ? { ...workout, title: null } : workout
          ),
        }

        // Act / Assert
        expect(problemsOf(planFromFhir(edited))).toContainEqual({
          _tag: 'WorkoutUntitled',
          index,
        })
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an exercise action missing its progression, sets or exercise, naming where', () => {
    fc.assert(
      fc.property(
        smallPlanArb,
        fc.nat(),
        fc.nat(),
        fc.constantFrom('progression' as const, 'sets' as const, 'exercise' as const),
        (plan, workoutSeed, exerciseSeed, missing) => {
          // Arrange
          const written = planToFhir(plan, options)
          const workoutIndex = workoutSeed % written.action.length
          const workout = written.action[workoutIndex]
          fc.pre(workout !== undefined)
          const index = exerciseSeed % workout.action.length
          const broken = workout.action[index]
          fc.pre(broken !== undefined)
          const edits = {
            progression: { ...broken, extension: [] },
            sets: { ...broken, code: broken.code.filter((_, at) => at !== 1) },
            exercise: { ...broken, code: broken.code.slice(1) },
          }
          const expected = {
            progression: { _tag: 'ProgressionUnreadable' },
            sets: { _tag: 'MeasureUnreadable', measure: LiftingMeasureCode.Sets },
            exercise: { _tag: 'ExerciseUnreadable' },
          }
          const edited = {
            ...written,
            action: written.action.map((each, at) =>
              at === workoutIndex
                ? {
                    ...each,
                    action: each.action.map((sub, subAt) =>
                      subAt === index ? edits[missing] : sub
                    ),
                  }
                : each
            ),
          }

          // Act / Assert
          expect(problemsOf(planFromFhir(edited))).toContainEqual({
            _tag: 'ExerciseActionUnreadable',
            workoutIndex,
            index,
            problems: [expected[missing]],
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should refuse an exercise whose copies under two workouts differ', () => {
    // Arrange: the squat is in both StrongLifts workouts; make B's a 3×5.
    const written = planToFhir(strongLifts5x5(), options)
    const edited = {
      ...written,
      action: written.action.map((workout, at) =>
        at === 1
          ? {
              ...workout,
              action: workout.action.map((exercise, subAt) =>
                subAt === 0
                  ? {
                      ...exercise,
                      code: exercise.code.map((concept, conceptAt) =>
                        conceptAt === 1
                          ? {
                              ...concept,
                              extension: concept.extension.map((extension) => ({
                                ...extension,
                                valueInteger: 3,
                              })),
                            }
                          : concept
                      ),
                    }
                  : exercise
              ),
            }
          : workout
      ),
    }

    // Act / Assert
    expect(problemsOf(planFromFhir(edited))).toEqual([
      { _tag: 'ExerciseDefinitionsDiffer', exerciseId: 'squat' },
    ])
  })

  it('should refuse a rule whose unit is not lb or kg, or whose sets are not positive', () => {
    // Arrange
    const written = planToFhir(strongLifts5x5(), options)
    const withSquatEdited = (
      edit: (
        squat: PlanDefinitionResource['action'][number]
      ) => PlanDefinitionResource['action'][number]
    ): PlanDefinitionResource => ({
      ...written,
      action: written.action.map((workout) => ({
        ...workout,
        action: workout.action.map((exercise) =>
          exercise.title === 'Squat' ? edit(exercise) : exercise
        ),
      })),
    })
    const stone = withSquatEdited((squat) => ({
      ...squat,
      extension: squat.extension.map((progression) => ({
        ...progression,
        extension: progression.extension.map((part) =>
          part.url === LiftingProgressionPart.Unit ? { ...part, valueString: 'st' } : part
        ),
      })),
    }))
    const zeroSets = withSquatEdited((squat) => ({
      ...squat,
      code: squat.code.map((concept, at) =>
        at === 1
          ? {
              ...concept,
              extension: concept.extension.map((extension) => ({
                ...extension,
                valueInteger: 0,
              })),
            }
          : concept
      ),
    }))

    // Act / Assert
    // The squat is in both workouts, so both copies are unreadable.
    expect(problemsOf(planFromFhir(stone)).map((problem) => problem._tag)).toEqual([
      'ExerciseActionUnreadable',
      'ExerciseActionUnreadable',
    ])
    expect(problemsOf(planFromFhir(stone))[0]).toMatchObject({
      problems: [{ _tag: 'ProgressionPartUnreadable', part: LiftingProgressionPart.Unit }],
    })
    expect(problemsOf(planFromFhir(zeroSets))[0]).toMatchObject({
      problems: [{ _tag: 'ExerciseOutOfRange', exerciseId: 'squat', field: 'sets' }],
    })
  })

  it("should ignore foreign concepts among an exercise action's codes", () => {
    fc.assert(
      fc.property(smallPlanArb, fc.array(foreignConceptArb), (plan, foreign) => {
        const written = planToFhir(plan, options)
        const padded = {
          ...written,
          action: written.action.map((workout) => ({
            ...workout,
            action: workout.action.map((exercise) => ({
              ...exercise,
              code: [...exercise.code, ...foreign],
            })),
          })),
        }
        expect(Either.map(planFromFhir(padded), (stored) => stored.plan)).toEqual(
          Either.right(plan)
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a foreign definition, reporting every missing part, and name them in the message', () => {
    const refused = Either.flip(planFromFhir(shell))
    expect(Either.map(refused, (unreadable) => unreadable.problems)).toEqual(
      Either.right([{ _tag: 'UrlMissing' }, { _tag: 'WorkoutsMissing' }])
    )
    expect(Either.map(refused, (unreadable) => unreadable.message)).toEqual(
      Either.right('plan unreadable: UrlMissing; WorkoutsMissing')
    )
  })

  it('should read a definition whose workouts share an exercise, planning it once', () => {
    const read = planFromFhir(planToFhir(strongLifts5x5(), options))
    expect(Either.map(read, (stored) => Option.some(stored.plan))).toEqual(
      Either.right(Option.some(strongLifts5x5()))
    )
  })
})
