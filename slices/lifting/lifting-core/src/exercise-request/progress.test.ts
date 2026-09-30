import { DateTime, Either, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { IdentifierAndReference } from 'fhir-r4/data-types'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it } from 'vite-plus/test'

import type * as ExerciseSetObservation from '../exercise-set-observation/exercise-set-observation.ts'
import * as Session from '../exercise-set-observation/session.ts'
import * as Load from '../load/load.ts'
import * as Plan from '../plan/plan.ts'
import * as PlannedExercise from '../plan/planned-exercise.ts'
import * as ProgressionRule from '../plan/progression-rule.ts'
import * as StrongLifts5x5 from '../plans/strong-lifts.ts'
import {
  AUTHORED_ON,
  deloadCaseArb,
  fewFailuresCaseArb,
  incrementCaseArb,
  made,
  type ProgressionCase,
  progressionCaseArb,
  ruleOf,
  setAt,
  someOrFail,
  SUBJECT,
  UTC,
  zoneArb,
} from '../test-helpers.ts'
import * as ExerciseRequest from './exercise-request.ts'

// Each case makes its `ExerciseRequest`s and sets through their schemas, so a property
// over them runs fewer iterations than one over plain values.
const RUNS = numRunsFor({ base: 60 })

const STEP_AUTHORED_ON = DateTime.unsafeMake('2026-01-07T18:00:00Z')

const plan = StrongLifts5x5.plan('plan-1')

/** The StrongLifts barbell rule: +5 lb, three failures deload 10% in 5 lb steps, never below 45 lb. */
const barbell = PlannedExercise.progressionRuleOf(someOrFail(Plan.plannedExerciseOf(plan, 'squat')))

/** The StrongLifts squat at `value` lb, stored as `sr-2`. */
const squatAt = (value: number): ExerciseRequest.Type =>
  made(
    ExerciseRequest.make({
      serviceRequestId: 'sr-2',
      subject: SUBJECT,
      plan,
      exerciseId: 'squat',
      load: made(Load.make({ value, unit: 'lb' })),
      authoredOn: AUTHORED_ON,
    })
  )

/** One progression step over `setObservations` in `zone`, issuing `sr-3`. */
const step = (spec: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly progressionRule: ProgressionRule.Type
  readonly setObservations: readonly ExerciseSetObservation.Type[]
  readonly zone?: DateTime.TimeZone
}): Either.Either<ExerciseRequest.Progress, unknown> =>
  ExerciseRequest.progress({
    ...spec,
    zone: spec.zone ?? UTC,
    nextServiceRequestId: 'sr-3',
    authoredOn: STEP_AUTHORED_ON,
  })

/** The step a generated case calls for, which must succeed. */
const stepOf = (progressionCase: ProgressionCase, zone = UTC): ExerciseRequest.Progress =>
  made(
    step({
      exerciseRequest: progressionCase.exerciseRequest,
      progressionRule: ruleOf(progressionCase.planned),
      setObservations: progressionCase.setObservations,
      zone,
    })
  )

/** The load value of an issued `ExerciseRequest`. */
const loadValueOf = (exerciseRequest: ExerciseRequest.Type): number =>
  Load.valueOf(ExerciseRequest.loadOf(exerciseRequest))

describe('ExerciseRequest.progress', () => {
  it('should hold an `ExerciseRequest` with no sets yet, writing nothing', () => {
    const current = squatAt(135)
    expect(
      step({ exerciseRequest: current, progressionRule: barbell, setObservations: [] })
    ).toEqual(Either.right({ decision: 'hold', current, next: Option.none() }))
  })

  it('should complete a met 135 lb squat and issue 140 lb in its place', () => {
    // Arrange
    const current = squatAt(135)

    // Act
    const progress = made(
      step({
        exerciseRequest: current,
        progressionRule: barbell,
        setObservations: session({ exerciseRequest: current, day: 1, reps: [5, 5, 5, 5, 5] }),
      })
    )

    // Assert
    const next = someOrFail(progress.next)
    expect(progress.decision).toBe('increment')
    expect(progress.current).toEqual({ ...current, status: 'completed' })
    expect(loadValueOf(next)).toBe(140)
    expect([next.id, next.status, next.authoredOn]).toEqual([
      'sr-3',
      'active',
      DateTime.formatIso(STEP_AUTHORED_ON),
    ])
    expect(next.replaces).toEqual([
      IdentifierAndReference.referenceTo({ resourceType: 'ServiceRequest', id: 'sr-2' }),
    ])
  })

  it('should hold after one and two failed sessions, and deload 10% after the third', () => {
    // Arrange
    const current = squatAt(150)
    const failures = [1, 2, 3].flatMap((day) =>
      session({ exerciseRequest: current, day, reps: [5, 5, 5, 4, 3] })
    )

    // Act
    const afterEach = [5, 10, 15].map((setCount) =>
      made(
        step({
          exerciseRequest: current,
          progressionRule: barbell,
          setObservations: failures.slice(0, setCount),
        })
      )
    )

    // Assert
    expect(afterEach.map((progress) => progress.decision)).toEqual(['hold', 'hold', 'deload'])
    // 150 × 0.9 is 134.99999… in floating point; it still lands on 135.
    expect(Option.map(afterEach[2]?.next ?? Option.none(), loadValueOf)).toEqual(Option.some(135))
    expect(afterEach[2]?.current.status).toBe('revoked')
  })

  it('should not deload below the empty bar', () => {
    // 50 × 0.9 = 45; 45 × 0.9 = 40.5 would round to 40, under the 45 lb floor.
    const at50 = squatAt(50)
    const at45 = squatAt(45)
    const failuresAt = (current: ExerciseRequest.Type): readonly ExerciseSetObservation.Type[] =>
      [1, 2, 3].flatMap((day) => session({ exerciseRequest: current, day, reps: [4, 4, 4, 4, 4] }))
    const from50 = made(
      step({ exerciseRequest: at50, progressionRule: barbell, setObservations: failuresAt(at50) })
    )
    expect(from50.decision).toBe('deload')
    expect(loadValueOf(someOrFail(from50.next))).toBe(45)
    expect(
      made(
        step({ exerciseRequest: at45, progressionRule: barbell, setObservations: failuresAt(at45) })
      ).decision
    ).toBe('hold')
  })

  it('should refuse a load in a unit the rule does not move', () => {
    const kilograms = made(
      ProgressionRule.make({
        unit: 'kg',
        increment: 2.5,
        failuresBeforeDeload: 3,
        deloadFraction: 0.1,
        minimumLoad: 20,
        loadStep: 2.5,
      })
    )
    const refused = step({
      exerciseRequest: squatAt(135),
      progressionRule: kilograms,
      setObservations: [],
    })
    expect(
      Either.match(refused, {
        onLeft: (error) => (error instanceof Error ? error.message : ''),
        onRight: () => '',
      })
    ).toContain('expected a load in kg')
  })

  it('should make the decision each class of history calls for', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        // Act
        const { decision, current, next } = stepOf(progressionCase)

        // Assert
        const { expected, exerciseRequest, planned } = progressionCase
        expect(decision).toBe(expected)
        if (expected === 'increment') {
          expect(current.status).toBe('completed')
          expect(loadValueOf(someOrFail(next))).toBe(
            loadValueOf(exerciseRequest) + ProgressionRule.incrementOf(ruleOf(planned))
          )
        } else if (expected === 'deload') {
          expect(current.status).toBe('revoked')
          expectDeloadedWithinRule({
            rule: ruleOf(planned),
            load: loadValueOf(exerciseRequest),
            deloaded: loadValueOf(someOrFail(next)),
          })
        } else if (expected === 'hold') {
          expect(current).toBe(exerciseRequest)
          expect(next).toEqual(Option.none())
        } else {
          assert.fail(`no expectation for ${String(expected satisfies never)}`)
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('should never let a deload land below the floor or above the load', () => {
    fc.assert(
      fc.property(deloadCaseArb, (progressionCase) => {
        const deloaded = loadValueOf(someOrFail(stepOf(progressionCase).next))
        expect(deloaded).toBeGreaterThanOrEqual(
          ProgressionRule.minimumLoadOf(ruleOf(progressionCase.planned))
        )
        expect(deloaded).toBeLessThan(loadValueOf(progressionCase.exerciseRequest))
      }),
      { numRuns: RUNS }
    )
  })

  it('should change nothing but the load, the id, the lineage and the date in what it issues', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        const current = progressionCase.exerciseRequest
        Option.map(stepOf(progressionCase).next, (issued) => {
          expect(ExerciseRequest.exerciseOf(issued)).toEqual(ExerciseRequest.exerciseOf(current))
          expect(Load.unitOf(ExerciseRequest.loadOf(issued))).toBe(
            Load.unitOf(ExerciseRequest.loadOf(current))
          )
          expect([ExerciseRequest.setsOf(issued), ExerciseRequest.repsOf(issued)]).toEqual([
            ExerciseRequest.setsOf(current),
            ExerciseRequest.repsOf(current),
          ])
          expect(issued.subject).toEqual(current.subject)
          expect(ExerciseRequest.planUrlOf(issued)).toBe(ExerciseRequest.planUrlOf(current))
        })
      }),
      { numRuns: RUNS }
    )
  })

  it('should hold what it issues, since nothing has been logged against it', () => {
    fc.assert(
      fc.property(progressionCaseArb, (progressionCase) => {
        Option.map(stepOf(progressionCase).next, (issued) => {
          expect(
            Either.map(
              step({
                exerciseRequest: issued,
                progressionRule: ruleOf(progressionCase.planned),
                setObservations: [],
              }),
              (progress) => progress.decision
            )
          ).toEqual(Either.right('hold'))
        })
      }),
      { numRuns: RUNS }
    )
  })

  it('should decide the same whatever order the sets arrive in', () => {
    fc.assert(
      fc.property(
        progressionCaseArb.chain((progressionCase) =>
          fc
            .shuffledSubarray([...progressionCase.setObservations], {
              minLength: progressionCase.setObservations.length,
            })
            .map((shuffled) => ({ progressionCase, shuffled }))
        ),
        ({ progressionCase, shuffled }) => {
          expect(stepOf({ ...progressionCase, setObservations: shuffled })).toEqual(
            stepOf(progressionCase)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should decide the same in any zone that keeps each generated session on one day', () => {
    // Generated sessions run from 18:00 UTC for under an hour, so a zone from
    // UTC−12 to UTC+5 keeps each one on a single local day.
    fc.assert(
      fc.property(
        progressionCaseArb,
        zoneArb.filter((zone) => Option.isSome(offsetHoursOf(zone))),
        (progressionCase, zone) => {
          fc.pre(Option.getOrElse(offsetHoursOf(zone), () => 99) <= 5)
          expect(stepOf(progressionCase, zone)).toEqual(stepOf(progressionCase))
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('should issue an `ExerciseRequest` its own schema reads back', () => {
    fc.assert(
      fc.property(incrementCaseArb, (progressionCase) => {
        const issued = someOrFail(stepOf(progressionCase).next)
        expect(Either.isRight(Schema.decodeEither(ExerciseRequest.Schema)(issued))).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })
})

describe('ExerciseRequest.consecutiveFailures', () => {
  it('should count exactly the failed sessions since the last met one', () => {
    fc.assert(
      fc.property(fewFailuresCaseArb, ({ exerciseRequest, setObservations, trailingFailures }) => {
        expect(
          ExerciseRequest.consecutiveFailures(
            exerciseRequest,
            Session.groupByDate(setObservations, UTC)
          )
        ).toBe(trailingFailures)
      }),
      { numRuns: RUNS }
    )
  })

  it('should be zero after a met session', () => {
    fc.assert(
      fc.property(incrementCaseArb, ({ exerciseRequest, setObservations }) => {
        expect(
          ExerciseRequest.consecutiveFailures(
            exerciseRequest,
            Session.groupByDate(setObservations, UTC)
          )
        ).toBe(0)
      }),
      { numRuns: RUNS }
    )
  })

  it('should reach the deload threshold on a deload-class history', () => {
    fc.assert(
      fc.property(deloadCaseArb, ({ planned, exerciseRequest, setObservations }) => {
        expect(
          ExerciseRequest.consecutiveFailures(
            exerciseRequest,
            Session.groupByDate(setObservations, UTC)
          )
        ).toBeGreaterThanOrEqual(ProgressionRule.failuresBeforeDeloadOf(ruleOf(planned)))
      }),
      { numRuns: RUNS }
    )
  })
})

// Helpers

/**
 * A deloaded load obeys the rule's promises, without recomputing it: below the
 * old load, at or above the floor, a step multiple unless it is the floor, and
 * no more than one step under the fraction.
 */
function expectDeloadedWithinRule({
  rule,
  load,
  deloaded,
}: {
  readonly rule: ProgressionRule.Type
  readonly load: number
  readonly deloaded: number
}): void {
  const deloadFraction = ProgressionRule.deloadFractionOf(rule)
  const loadStep = ProgressionRule.loadStepOf(rule)
  const minimumLoad = ProgressionRule.minimumLoadOf(rule)
  expect(deloaded).toBeLessThan(load)
  expect(deloaded).toBeGreaterThanOrEqual(minimumLoad)
  if (deloaded !== minimumLoad) {
    const steps = deloaded / loadStep
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6)
    expect(deloaded).toBeLessThanOrEqual(load * (1 - deloadFraction) + 1e-6)
    expect(deloaded).toBeGreaterThan(load * (1 - deloadFraction) - loadStep - 1e-6)
  }
}

/** A fixed-offset zone's whole hours from UTC; `None` for a named zone. */
function offsetHoursOf(zone: DateTime.TimeZone): Option.Option<number> {
  return DateTime.isTimeZoneOffset(zone) ? Option.some(zone.offset / 3_600_000) : Option.none()
}

/** The sets of one session against `exerciseRequest` on January `day` 2026 at 18:00 UTC, three minutes apart. */
function session({
  exerciseRequest,
  day,
  reps,
}: {
  readonly exerciseRequest: ExerciseRequest.Type
  readonly day: number
  readonly reps: readonly number[]
}): readonly ExerciseSetObservation.Type[] {
  return reps.map((setReps, index) =>
    setAt({
      exerciseRequest,
      workoutLabel: day % 2 === 1 ? 'A' : 'B',
      start: DateTime.unsafeMake(Date.UTC(2026, 0, day, 18, index * 3)),
      reps: setReps,
    })
  )
}
