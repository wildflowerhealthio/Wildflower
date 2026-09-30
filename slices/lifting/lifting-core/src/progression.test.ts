import { DateTime, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { assert, describe, expect, it } from 'vite-plus/test'

import type { PlannedExercise, ProgressionRule } from './plan.ts'
import type { Prescription } from './prescription.ts'
import { consecutiveFailures, progressPrescription } from './progression.ts'
import { sessionsOf } from './session.ts'
import type { SetResult } from './set-result.ts'
import {
  deloadCaseArb,
  fewFailuresCaseArb,
  incrementCaseArb,
  progressionCaseArb,
  someOrFail,
  UTC,
  zoneArb,
} from './test-helpers.ts'

const RUNS = numRunsFor({ base: 200 })

const barbell: ProgressionRule = {
  unit: 'lb',
  increment: 5,
  failuresBeforeDeload: 3,
  deloadFraction: 0.1,
  minimumLoad: 45,
  loadStep: 5,
}

describe('progressPrescription', () => {
  it('should hold a prescription with no sets yet', () => {
    expect(progressPrescription(barbell, squatAt(135), [], UTC)).toEqual(
      Either.right({ decision: 'hold', next: Option.none() })
    )
  })

  it('should issue 140 lb after a met 135 lb squat session', () => {
    const progress = Either.getOrThrow(
      progressPrescription(barbell, squatAt(135), session(1, [5, 5, 5, 5, 5]), UTC)
    )
    expect(progress.decision).toBe('increment')
    expect(someOrFail(progress.next).load).toEqual({ value: 140, unit: 'lb' })
  })

  it('should hold after one and two failed sessions, and deload 10% after the third', () => {
    // Arrange
    const failures = [1, 2, 3].flatMap((day) => session(day, [5, 5, 5, 4, 3]))

    // Act
    const afterEach = [5, 10, 15].map((setCount) =>
      Either.getOrThrow(
        progressPrescription(barbell, squatAt(150), failures.slice(0, setCount), UTC)
      )
    )

    // Assert
    expect(afterEach.map((progress) => progress.decision)).toEqual(['hold', 'hold', 'deload'])
    // 150 × 0.9 is 134.99999… in floating point; it still lands on 135.
    expect(Option.map(afterEach[2]?.next ?? Option.none(), (next) => next.load.value)).toEqual(
      Option.some(135)
    )
  })

  it('should not deload below the empty bar', () => {
    // 50 × 0.9 = 45; 45 × 0.9 = 40.5 would round to 40, under the 45 lb floor.
    const failures = [1, 2, 3].flatMap((day) => session(day, [4, 4, 4, 4, 4]))
    const at50 = Either.getOrThrow(progressPrescription(barbell, squatAt(50), failures, UTC))
    expect(at50.decision).toBe('deload')
    expect(someOrFail(at50.next).load.value).toBe(45)
    expect(Either.getOrThrow(progressPrescription(barbell, squatAt(45), failures, UTC))).toEqual({
      decision: 'hold',
      next: Option.none(),
    })
  })

  it('should refuse a load in a unit the rule does not move', () => {
    const kilos: Prescription = { ...squatAt(60), load: { value: 60, unit: 'kg' } }
    expect(progressPrescription(barbell, kilos, [], UTC)).toEqual(
      Either.left({ _tag: 'LoadUnitMismatch', expected: 'lb', given: 'kg' })
    )
  })

  it('should make the decision each class of history calls for', () => {
    fc.assert(
      fc.property(progressionCaseArb, ({ expected, planned, prescription, sets }) => {
        // Act
        const { decision, next } = Either.getOrThrow(
          progressPrescription(planned.progression, prescription, sets, UTC)
        )

        // Assert
        expect(decision).toBe(expected)
        if (expected === 'increment') {
          expect(someOrFail(next).load.value).toBe(
            prescription.load.value + planned.progression.increment
          )
        } else if (expected === 'deload') {
          expectDeloadedWithinRule(planned, prescription, someOrFail(next).load.value)
        } else if (expected === 'hold') {
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
      fc.property(deloadCaseArb, ({ planned, prescription, sets }) => {
        const { next } = Either.getOrThrow(
          progressPrescription(planned.progression, prescription, sets, UTC)
        )
        expect(someOrFail(next).load.value).toBeGreaterThanOrEqual(planned.progression.minimumLoad)
        expect(someOrFail(next).load.value).toBeLessThan(prescription.load.value)
      }),
      { numRuns: RUNS }
    )
  })

  it('should change nothing but the load value in what it issues', () => {
    fc.assert(
      fc.property(progressionCaseArb, ({ planned, prescription, sets }) => {
        const { next } = Either.getOrThrow(
          progressPrescription(planned.progression, prescription, sets, UTC)
        )
        Option.map(next, (issued) => {
          expect({ ...issued, load: prescription.load }).toEqual(prescription)
        })
      }),
      { numRuns: RUNS }
    )
  })

  it('should hold what it issues, since nothing has been logged against it', () => {
    fc.assert(
      fc.property(progressionCaseArb, ({ planned, prescription, sets }) => {
        const { next } = Either.getOrThrow(
          progressPrescription(planned.progression, prescription, sets, UTC)
        )
        Option.map(next, (issued) => {
          expect(progressPrescription(planned.progression, issued, [], UTC)).toEqual(
            Either.right({ decision: 'hold', next: Option.none() })
          )
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
            .shuffledSubarray([...progressionCase.sets], {
              minLength: progressionCase.sets.length,
            })
            .map((shuffled) => ({ ...progressionCase, shuffled }))
        ),
        ({ planned, prescription, sets, shuffled }) => {
          expect(progressPrescription(planned.progression, prescription, shuffled, UTC)).toEqual(
            progressPrescription(planned.progression, prescription, sets, UTC)
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
        ({ planned, prescription, sets }, zone) => {
          fc.pre(Option.getOrElse(offsetHoursOf(zone), () => 99) <= 5)
          expect(progressPrescription(planned.progression, prescription, sets, zone)).toEqual(
            progressPrescription(planned.progression, prescription, sets, UTC)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('consecutiveFailures', () => {
  it('should count exactly the failed sessions since the last met one', () => {
    fc.assert(
      fc.property(fewFailuresCaseArb, ({ prescription, sets, trailingFailures }) => {
        expect(consecutiveFailures(prescription, sessionsOf(sets, UTC))).toBe(trailingFailures)
      }),
      { numRuns: RUNS }
    )
  })

  it('should be zero after a met session', () => {
    fc.assert(
      fc.property(incrementCaseArb, ({ prescription, sets }) => {
        expect(consecutiveFailures(prescription, sessionsOf(sets, UTC))).toBe(0)
      }),
      { numRuns: RUNS }
    )
  })

  it('should reach the deload threshold on a deload-class history', () => {
    fc.assert(
      fc.property(deloadCaseArb, ({ planned, prescription, sets }) => {
        expect(consecutiveFailures(prescription, sessionsOf(sets, UTC))).toBeGreaterThanOrEqual(
          planned.progression.failuresBeforeDeload
        )
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
function expectDeloadedWithinRule(
  planned: PlannedExercise,
  prescription: Prescription,
  deloaded: number
): void {
  const { deloadFraction, loadStep, minimumLoad } = planned.progression
  const load = prescription.load.value
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

function squatAt(value: number): Prescription {
  return {
    exercise: { id: 'squat', name: 'Squat' },
    load: { value, unit: 'lb' },
    sets: 5,
    reps: 5,
  }
}

/** The sets of one squat session on January `day` 2026 at 18:00 UTC, three minutes apart. */
function session(day: number, reps: readonly number[]): readonly SetResult[] {
  return reps.map((setReps, index) => {
    const start = DateTime.unsafeMake(Date.UTC(2026, 0, day, 18, index * 3))
    return {
      exercise: { id: 'squat', name: 'Squat' },
      workoutLabel: day % 2 === 1 ? 'A' : 'B',
      start,
      end: DateTime.addDuration(start, '1 minute'),
      reps: setReps,
    }
  })
}
