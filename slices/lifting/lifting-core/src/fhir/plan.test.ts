import { DateTime, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import { CarePlan, Goal } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { strongLifts5x5 } from '../strong-lifts.ts'
import { goalArb, instantArb, planArb, smallPlanArb } from '../test-helpers.ts'
import { LIFTING_PLAN_CATEGORY_TOKEN } from './elements.ts'
import { exerciseGoalToFhir } from './goal.ts'
import { planFromFhir, planToFhir } from './plan.ts'
import { foreignConceptArb, problemsOf, throughWire } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

// A whole CarePlan and its Goals through encode → JSON → decode is the slow
// path (every Goal carries ~50 `value[x]` slots per extension), so the wire
// round-trip runs fewer iterations than the in-memory properties.
const WIRE_RUNS = numRunsFor({ base: 25 })

const options = {
  carePlanId: 'plan-1',
  created: DateTime.unsafeMake('2026-09-26T14:30:00.000Z'),
  goalIdFor: (exerciseId: string) => `goal-${exerciseId}`,
  subject: 'Patient/p-1',
}

/** Just the plan a successful read stored, for properties about the plan alone. */
const planOf = (read: ReturnType<typeof planFromFhir>): Either.Either<unknown, unknown> =>
  Either.map(read, (stored) => stored.plan)

describe('planToFhir / planFromFhir', () => {
  it('should write StrongLifts as an active CarePlan with one activity per workout exercise', () => {
    // Act
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)

    // Assert
    expect(carePlan.status).toBe('active')
    expect(carePlan.intent).toBe('plan')
    expect(carePlan.subject.reference).toBe('Patient/p-1')
    expect(goals).toHaveLength(5)
    expect(carePlan.goal.map((reference) => reference.reference)).toEqual(
      goals.map((goal) => `Goal/${goal.id}`)
    )
    expect(
      carePlan.activity.map((activity) => [
        activity.detail?.extension[0]?.valueString,
        activity.detail?.code?.coding[0]?.code,
        activity.detail?.goal[0]?.reference,
      ])
    ).toEqual([
      ['A', 'squat', 'Goal/goal-squat'],
      ['A', 'bench-press', 'Goal/goal-bench-press'],
      ['A', 'barbell-row', 'Goal/goal-barbell-row'],
      ['B', 'squat', 'Goal/goal-squat'],
      ['B', 'overhead-press', 'Goal/goal-overhead-press'],
      ['B', 'deadlift', 'Goal/goal-deadlift'],
    ])
  })

  it('should read back every plan it writes, with the ids and creation time it was given, through the encoded wire form', () => {
    fc.assert(
      fc.property(smallPlanArb, instantArb, fc.uuid(), (plan, created, carePlanId) => {
        // Arrange
        const goalIdFor = (exerciseId: string): string => `${carePlanId}-${exerciseId}`
        const { carePlan, goals } = planToFhir(plan, {
          ...options,
          carePlanId,
          goalIdFor,
          created,
        })

        // Act
        const read = planFromFhir(
          throughWire(CarePlan.Schema, carePlan),
          goals.map((goal) => throughWire(Goal.Schema, goal))
        )

        // Assert
        expect(
          Either.map(read, (stored) => ({
            ...stored,
            created: Option.map(stored.created, DateTime.toEpochMillis),
          }))
        ).toEqual(
          Either.right({
            plan,
            carePlanId,
            goalIdByExerciseId: Object.fromEntries(
              Object.keys(plan.goalsByExerciseId).map((exerciseId) => [
                exerciseId,
                goalIdFor(exerciseId),
              ])
            ),
            created: Option.some(DateTime.toEpochMillis(created)),
          })
        )
      }),
      { numRuns: WIRE_RUNS }
    )
  })

  it('should write the creation time as CarePlan.created in ISO form', () => {
    const { carePlan } = planToFhir(strongLifts5x5(), options)
    expect(carePlan.created).toBe('2026-09-26T14:30:00.000Z')
  })

  it('should read a CarePlan with no created as a stored plan created at no known time', () => {
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    expect(
      Either.map(planFromFhir({ ...carePlan, created: null }, goals), (stored) => stored.created)
    ).toEqual(Either.right(Option.none()))
  })

  it.each([
    'last tuesday',
    // What `new Date` would guess at: a US-style date, and a zone-less time
    // it would read in the local zone.
    'September 26, 2026',
    '2026-09-26T14:30:00',
    // The `dateTime` form, but no real instant.
    '2026-09-26T14:30:60Z',
  ])('should refuse a created of %j, which is not a FHIR dateTime instant', (created) => {
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    expect(problemsOf(planFromFhir({ ...carePlan, created }, goals))).toEqual([
      { _tag: 'CreatedUnreadable', created },
    ])
  })

  it.each([
    ['2026-09-26T10:30:00-04:00', '2026-09-26T14:30:00.000Z'],
    ['2026-09-26', '2026-09-26T00:00:00.000Z'],
    ['2026', '2026-01-01T00:00:00.000Z'],
  ])('should read a created of %j as the instant %j', (created, instant) => {
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    expect(
      Either.map(planFromFhir({ ...carePlan, created }, goals), (stored) =>
        Option.map(stored.created, DateTime.formatIso)
      )
    ).toEqual(Either.right(Option.some(instant)))
  })

  it('should file the CarePlan under the lifting plan category, the token a search finds it by', () => {
    const { carePlan } = planToFhir(strongLifts5x5(), options)
    expect(
      carePlan.category.flatMap((concept) =>
        concept.coding.map((coding) => `${coding.system?.href ?? ''}|${coding.code ?? ''}`)
      )
    ).toEqual([LIFTING_PLAN_CATEGORY_TOKEN])
  })

  it('should refuse a CarePlan with no id, which an edit could not be stored under', () => {
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    expect(problemsOf(planFromFhir({ ...carePlan, id: null }, goals))).toEqual([
      { _tag: 'CarePlanIdMissing' },
    ])
  })

  it('should ignore goals the CarePlan does not reference', () => {
    fc.assert(
      fc.property(planArb, goalArb, (plan, stranger) => {
        const { carePlan, goals } = planToFhir(plan, options)
        const unrelated = exerciseGoalToFhir(stranger, {
          goalId: 'not-in-plan',
          subject: 'Patient/p-1',
        })
        expect(planOf(planFromFhir(carePlan, [unrelated, ...goals]))).toEqual(Either.right(plan))
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a plan whose referenced goal is missing, naming it and the exercises it leaves bare', () => {
    fc.assert(
      fc.property(planArb, fc.nat(), (plan, seed) => {
        // Arrange
        const { carePlan, goals } = planToFhir(plan, options)
        const dropped = goals[seed % goals.length]
        fc.pre(dropped !== undefined && dropped.id !== null)

        // Act
        const problems = problemsOf(
          planFromFhir(
            carePlan,
            goals.filter((goal) => goal !== dropped)
          )
        )

        // Assert
        const droppedExerciseId = dropped.id.replace(/^goal-/, '')
        expect(problems[0]).toEqual({ _tag: 'GoalMissing', reference: `Goal/${dropped.id}` })
        expect(problems.slice(1)).toEqual(
          plan.workouts
            .filter((workout) => workout.exerciseIds.includes(droppedExerciseId))
            .map((workout) => ({
              _tag: 'WorkoutExerciseWithoutGoal',
              label: workout.label,
              exerciseId: droppedExerciseId,
            }))
        )
      }),
      { numRuns: RUNS }
    )
  })

  it("should refuse a plan whose goal can't be read, carrying the goal's own problems", () => {
    // Arrange
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    const noLoad = goals.map((goal) =>
      goal.id === 'goal-squat' ? { ...goal, target: goal.target.slice(1) } : goal
    )

    // Act / Assert
    expect(problemsOf(planFromFhir(carePlan, noLoad))[0]).toEqual({
      _tag: 'ReferencedGoalUnreadable',
      reference: 'Goal/goal-squat',
      problems: [{ _tag: 'TargetUnreadable', measure: 'load-lb' }],
    })
  })

  it('should report every problem at once, not only the first', () => {
    // Arrange
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    const broken = {
      ...carePlan,
      title: null,
      activity: carePlan.activity.map((activity, index) =>
        index === 1 && activity.detail !== null
          ? { ...activity, detail: { ...activity.detail, extension: [], code: null } }
          : activity
      ),
    }

    // Act
    const tags = problemsOf(planFromFhir(broken, goals.slice(1))).map((problem) => problem._tag)

    // Assert
    expect(tags).toEqual([
      'GoalMissing',
      'ActivityUnlabelled',
      'ActivityUncoded',
      'TitleEmpty',
      'WorkoutExerciseWithoutGoal',
      'WorkoutExerciseWithoutGoal',
    ])
  })

  it('should refuse a plan with no activities', () => {
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    expect(problemsOf(planFromFhir({ ...carePlan, activity: [] }, goals))).toEqual([
      { _tag: 'WorkoutsMissing' },
    ])
  })

  it("should refuse a workout whose activities are split by another workout's", () => {
    // Arrange: A, A, A, B, B, B → A, B, A, B, B, A-shaped interleaving
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    const [a1, a2, a3, b1, b2, b3] = carePlan.activity
    if (a1 === undefined || a2 === undefined || a3 === undefined) throw new Error('A has 3')
    if (b1 === undefined || b2 === undefined || b3 === undefined) throw new Error('B has 3')
    const interleaved = { ...carePlan, activity: [a1, a2, b1, b2, b3, a3] }

    // Act / Assert
    expect(problemsOf(planFromFhir(interleaved, goals))).toEqual([
      { _tag: 'WorkoutLabelSplit', label: 'A' },
    ])
  })

  it('should refuse a goal id given twice as ambiguous, rather than take the first', () => {
    fc.assert(
      fc.property(planArb, fc.nat(), (plan, seed) => {
        // Arrange
        const { carePlan, goals } = planToFhir(plan, options)
        const doubled = goals[seed % goals.length]
        fc.pre(doubled !== undefined)

        // Act
        const problems = problemsOf(planFromFhir(carePlan, [...goals, doubled]))

        // Assert
        expect(problems[0]).toEqual({ _tag: 'GoalAmbiguous', reference: `Goal/${doubled.id}` })
      }),
      { numRuns: RUNS }
    )
  })

  it('should name its problems in the error message', () => {
    const { carePlan, goals } = planToFhir(strongLifts5x5(), options)
    const refused = Either.flip(planFromFhir({ ...carePlan, activity: [] }, goals))
    expect(Either.map(refused, (unreadable) => unreadable.message)).toEqual(
      Either.right('plan unreadable: WorkoutsMissing')
    )
  })

  it('should refuse two goals for one exercise', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        // Arrange
        const { carePlan, goals } = planToFhir(plan, options)
        const [first] = goals
        fc.pre(first !== undefined)
        const twin = { ...first, id: 'twin' }
        const doubled = {
          ...carePlan,
          goal: [
            ...carePlan.goal,
            { ...IdentifierAndReference.emptyReference, reference: 'Goal/twin' },
          ],
        }

        // Act / Assert
        expect(problemsOf(planFromFhir(doubled, [...goals, twin]))).toEqual([
          { _tag: 'GoalDuplicate', exerciseId: first.id?.replace(/^goal-/, '') },
        ])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a CarePlan of foreign activities without throwing', () => {
    fc.assert(
      fc.property(planArb, fc.array(foreignConceptArb, { minLength: 1 }), (plan, codes) => {
        // Arrange
        const { carePlan, goals } = planToFhir(plan, options)
        const [template] = carePlan.activity
        const detail = template?.detail
        fc.pre(template !== undefined && detail !== null && detail !== undefined)
        const foreign = codes.map((code) => ({
          ...template,
          detail: { ...detail, code, extension: [] },
        }))

        // Act
        const problems = problemsOf(planFromFhir({ ...carePlan, activity: foreign }, goals))

        // Assert
        expect(problems.slice(0, 2 * codes.length)).toEqual(
          codes.flatMap((_, index) => [
            { _tag: 'ActivityUnlabelled', index },
            { _tag: 'ActivityUncoded', index },
          ])
        )
      }),
      { numRuns: RUNS }
    )
  })
})
