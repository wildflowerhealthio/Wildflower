import { Array as Arr, type DateTime, Either, Option, pipe } from 'effect'

import type { ProgressionRule } from './plan.ts'
import { atLoad, type Prescription, PrescriptionProblem } from './prescription.ts'
import { type Session, sessionMet, sessionsOf } from './session.ts'
import type { SetResult } from './set-result.ts'

/**
 * What a prescription's sessions do to it: close it as met and issue the next
 * at the incremented load, keep it open, or close it as abandoned and issue
 * the next at the deloaded load.
 */
type ProgressionDecision = 'increment' | 'hold' | 'deload'

/** The {@link ProgressionDecision} {@link progressPrescription} made, and the prescription it issues. */
interface PrescriptionProgress {
  /** Which way the load moved. */
  readonly decision: ProgressionDecision
  /**
   * The prescription to issue in place of the current one: at the new load,
   * everything else unchanged; `None` on a hold, which keeps the current one.
   */
  readonly next: Option.Option<Prescription>
}

/** The one {@link PrescriptionProblem} a progression step can hit: the load and the rule disagree on the unit. */
type LoadUnitMismatch = Extract<PrescriptionProblem, { readonly _tag: 'LoadUnitMismatch' }>

/**
 * Tolerance for floating-point error when rounding a deloaded load down to a
 * step multiple, so `150 × 0.9` computed as `134.99999…` still lands on 135.
 */
const ROUNDING_TOLERANCE = 1e-9

/**
 * How many of a prescription's most recent sessions in a row failed — the
 * count a deload waits on ("failure 2 of 3").
 *
 * @param prescription - The prescription the sessions were at
 * @param sessions - Its sessions, earliest first, as {@link sessionsOf} groups them
 * @returns The length of the trailing run of sessions that did not meet the prescription
 *
 * @remarks
 * Every session here is at the prescription's load — a prescription is one
 * load, and a load change issues a new one — so no session before the current
 * load can count against it.
 */
const consecutiveFailures = (prescription: Prescription, sessions: readonly Session[]): number =>
  pipe(
    Arr.reverse(sessions),
    Arr.takeWhile((session) => !sessionMet(prescription, session))
  ).length

/** `load` rounded down to a multiple of `step`, within {@link ROUNDING_TOLERANCE}. */
const roundDownToStep = (load: number, step: number): number =>
  Math.floor(load / step + ROUNDING_TOLERANCE) * step

/**
 * The load a deload lands on: cut by `deloadFraction`, rounded down to a
 * multiple of `loadStep`, and raised back to `minimumLoad` if it fell below it.
 *
 * @remarks
 * Rounding down, not to nearest, so a deload never lands above the fraction it
 * promises. The rounded load is also capped at the current load rounded down
 * with no tolerance, so the tolerance can never lift a load that sits a hair
 * under a step multiple.
 */
const deloadedLoad = (rule: ProgressionRule, load: number): number =>
  Math.max(
    rule.minimumLoad,
    Math.min(
      roundDownToStep(load * (1 - rule.deloadFraction), rule.loadStep),
      Math.floor(load / rule.loadStep) * rule.loadStep
    )
  )

/** The deload step when enough failures have piled up and the deload would lower the load. */
const deloadOf = (
  rule: ProgressionRule,
  prescription: Prescription,
  sessions: readonly Session[]
): Option.Option<PrescriptionProgress> =>
  pipe(
    Option.some(deloadedLoad(rule, prescription.load.value)),
    Option.filter(
      (deloaded) =>
        deloaded < prescription.load.value &&
        consecutiveFailures(prescription, sessions) >= rule.failuresBeforeDeload
    ),
    Option.map((deloaded): PrescriptionProgress => ({
      decision: 'deload',
      next: Option.some(atLoad(prescription, deloaded)),
    }))
  )

/**
 * One progression step for one prescription: decide from the sets logged
 * against it whether its load goes up, stays, or deloads, and the prescription
 * to issue next.
 *
 * @param rule - The plan's rule for the prescription's exercise
 * @param prescription - The current prescription, in the ranges `prescribe` accepts
 * @param sets - Every set logged against `prescription`, in any order
 * @param zone - The lifter's time zone, which groups the sets into sessions
 * @returns The decision and the next prescription; or `LoadUnitMismatch` when
 *   `prescription.load` is in a unit `rule` does not move
 *
 * @remarks
 * The rule, over the sets grouped by {@link sessionsOf}:
 *
 * - **increment** — the most recent session met the prescription (see
 *   `sessionMet`): the next prescription is `rule.increment` heavier.
 * - **deload** — otherwise, when {@link consecutiveFailures} has reached
 *   `rule.failuresBeforeDeload` and the deloaded load (cut by
 *   `deloadFraction`, rounded down to a multiple of `loadStep`, never below
 *   `minimumLoad`) is lower than the current one.
 * - **hold** — otherwise: no sets yet, too few failures, or a deload that
 *   would not lower a load already at its floor. Nothing is issued.
 *
 * An increment closes the current prescription as met (a `completed`
 * request); a deload closes it as abandoned (`revoked`). The next one starts
 * with no sets, so running the step on it holds until its own sessions say
 * otherwise.
 */
const progressPrescription = (
  rule: ProgressionRule,
  prescription: Prescription,
  sets: readonly SetResult[],
  zone: DateTime.TimeZone
): Either.Either<PrescriptionProgress, LoadUnitMismatch> => {
  if (prescription.load.unit !== rule.unit)
    return Either.left(
      PrescriptionProblem.LoadUnitMismatch({ expected: rule.unit, given: prescription.load.unit })
    )
  const sessions = sessionsOf(sets, zone)
  return Either.right(
    pipe(
      Arr.last(sessions),
      Option.filter((latest) => sessionMet(prescription, latest)),
      Option.map((): PrescriptionProgress => ({
        decision: 'increment',
        next: Option.some(atLoad(prescription, prescription.load.value + rule.increment)),
      })),
      Option.orElse(() => deloadOf(rule, prescription, sessions)),
      Option.getOrElse((): PrescriptionProgress => ({ decision: 'hold', next: Option.none() }))
    )
  )
}

export { consecutiveFailures, progressPrescription }
export type { LoadUnitMismatch, PrescriptionProgress, ProgressionDecision }
