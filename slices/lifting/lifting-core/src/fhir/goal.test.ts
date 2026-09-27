import { Array as Arr, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { Code, WildflowerExtension } from 'fhir-r4/data-types'
import { Goal } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { strongLifts5x5 } from '../strong-lifts.ts'
import { goalArb } from '../test-helpers.ts'
import { LiftingMeasureCode, LiftingProgressionPart } from './elements.ts'
import { exerciseGoalFromFhir, exerciseGoalToFhir, type GoalResource } from './goal.ts'
import { foreignConceptArb, problemsOf, throughWire } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

const options = { goalId: 'g-1', subject: 'Patient/p-1' }

/** A decoded `Goal` carrying nothing lifting-specific, for generated fields to be spread onto. */
const shell: GoalResource = Schema.decodeUnknownSync(Goal.Schema)({
  resourceType: 'Goal',
  lifecycleStatus: 'active',
  description: { text: 'Walk more' },
  subject: { reference: 'Patient/p-1' },
})

const PARTS = Object.values(LiftingProgressionPart)

describe('exerciseGoalToFhir / exerciseGoalFromFhir', () => {
  it('should read back every goal it writes, through the encoded wire form', () => {
    fc.assert(
      fc.property(goalArb, (goal) => {
        const wire = throughWire(Goal.Schema, exerciseGoalToFhir(goal, options))
        expect(exerciseGoalFromFhir(wire)).toEqual(Either.right(goal))
      }),
      { numRuns: RUNS }
    )
  })

  it('should carry the load as UCUM pounds and the rule as one sub-extension per part', () => {
    // Arrange
    const squat = strongLifts5x5().goalsByExerciseId.squat
    if (squat === undefined) throw new Error('StrongLifts has a squat')

    // Act
    const wire = Schema.encodeSync(Goal.Schema)(exerciseGoalToFhir(squat, options))

    // Assert
    expect(wire.description.text).toBe('Squat')
    expect(wire.target?.[0]?.detailQuantity).toMatchObject({
      value: 45,
      unit: 'lb',
      system: 'http://unitsofmeasure.org',
      code: '[lb_av]',
    })
    expect(wire.extension).toMatchObject([
      {
        url: WildflowerExtension.LiftingProgression,
        extension: [
          { url: 'incrementLb', valueDecimal: 5 },
          { url: 'failuresBeforeDeload', valueInteger: 3 },
          { url: 'deloadFraction', valueDecimal: 0.1 },
          { url: 'minimumLoadLb', valueDecimal: 45 },
          { url: 'loadStepLb', valueDecimal: 5 },
        ],
      },
    ])
  })

  it('should refuse a load written in kilograms', () => {
    fc.assert(
      fc.property(goalArb, (goal) => {
        const written = exerciseGoalToFhir(goal, options)
        const inKilograms = {
          ...written,
          target: written.target.map((target, index) =>
            index === 0
              ? {
                  ...target,
                  detailQuantity: {
                    id: null,
                    extension: [],
                    value: goal.loadLb,
                    unit: 'kg',
                    system: 'http://unitsofmeasure.org',
                    code: Code.make('kg'),
                    comparator: null,
                  },
                }
              : target
          ),
        }
        expect(problemsOf(exerciseGoalFromFhir(inKilograms))).toEqual([
          { _tag: 'TargetUnreadable', measure: LiftingMeasureCode.LoadLb },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a duplicated target rather than take the first', () => {
    fc.assert(
      fc.property(goalArb, fc.nat(), (goal, seed) => {
        const written = exerciseGoalToFhir(goal, options)
        const index = seed % written.target.length
        const doubled = {
          ...written,
          target: [...written.target, ...written.target.slice(index, index + 1)],
        }
        expect(problemsOf(exerciseGoalFromFhir(doubled))).toEqual([
          {
            _tag: 'TargetUnreadable',
            measure: [LiftingMeasureCode.LoadLb, LiftingMeasureCode.Sets, LiftingMeasureCode.Reps][
              index
            ],
          },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a goal missing or duplicating any part of its progression rule, naming the part', () => {
    fc.assert(
      fc.property(goalArb, fc.constantFrom(...PARTS), fc.boolean(), (goal, part, duplicate) => {
        // Arrange
        const written = exerciseGoalToFhir(goal, options)
        const edited = {
          ...written,
          extension: written.extension.map((progression) => ({
            ...progression,
            extension: duplicate
              ? [
                  ...progression.extension,
                  ...progression.extension.filter((sub) => sub.url === part),
                ]
              : progression.extension.filter((sub) => sub.url !== part),
          })),
        }

        // Act / Assert
        expect(problemsOf(exerciseGoalFromFhir(edited))).toEqual([
          { _tag: 'ProgressionPartUnreadable', part },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a value out of range, naming the field', () => {
    fc.assert(
      fc.property(goalArb, (goal) => {
        const written = exerciseGoalToFhir(
          { ...goal, progression: { ...goal.progression, deloadFraction: 1 } },
          options
        )
        expect(problemsOf(exerciseGoalFromFhir(written))).toEqual([
          { _tag: 'GoalOutOfRange', exerciseId: goal.exercise.id, field: 'deloadFraction' },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a foreign goal, reporting every missing part, and never throw', () => {
    fc.assert(
      fc.property(foreignConceptArb, (description) => {
        const tags = problemsOf(exerciseGoalFromFhir({ ...shell, description })).map(
          (problem) => problem._tag
        )
        expect(tags).toEqual([
          'ExerciseUnreadable',
          'TargetUnreadable',
          'TargetUnreadable',
          'TargetUnreadable',
          'ProgressionUnreadable',
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should ignore targets that measure something foreign', () => {
    fc.assert(
      fc.property(goalArb, fc.array(fc.tuple(foreignConceptArb, fc.integer())), (goal, foreign) => {
        const written = exerciseGoalToFhir(goal, options)
        const [firstTarget] = written.target
        fc.pre(firstTarget !== undefined)
        const withForeign = {
          ...written,
          target: [
            ...foreign.map(([measure, detailInteger]) => ({
              ...firstTarget,
              measure,
              detailQuantity: null,
              detailInteger,
            })),
            ...written.target,
          ],
        }
        expect(exerciseGoalFromFhir(withForeign)).toEqual(Either.right(goal))
      }),
      { numRuns: RUNS }
    )
  })

  it('should name its problems in the error message', () => {
    fc.assert(
      fc.property(goalArb, (goal) => {
        const written = exerciseGoalToFhir(goal, options)
        const refused = Either.flip(exerciseGoalFromFhir({ ...written, extension: [] }))
        expect(Either.map(refused, (unreadable) => unreadable.message)).toEqual(
          Either.right('goal unreadable: ProgressionUnreadable')
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse an exercise coding without a display', () => {
    fc.assert(
      fc.property(goalArb, (goal) => {
        const written = exerciseGoalToFhir(goal, options)
        const unnamed = {
          ...written,
          description: {
            ...written.description,
            coding: Arr.map(written.description.coding, (coding) => ({ ...coding, display: null })),
          },
        }
        expect(problemsOf(exerciseGoalFromFhir(unnamed))).toEqual([{ _tag: 'ExerciseUnreadable' }])
      }),
      { numRuns: RUNS }
    )
  })
})
