/**
 * The FHIR R4 adapters for strength-training plans, after HL7's Physical
 * Activity IG: a `Plan` as a `CarePlan` plus one `Goal` per exercise
 * ({@link planToFhir} / {@link planFromFhir}), one exercise's goal as a
 * `Goal` ({@link exerciseGoalToFhir} / {@link exerciseGoalFromFhir}, for
 * writing a progressed goal back), and an attempt as an `Observation`
 * ({@link attemptToFhir} / {@link attemptFromFhir}).
 *
 * Reading back what the writer wrote gives back the same value for plans and
 * goals — a plan comes back as a `StoredPlan`, with the `CarePlan` id, each
 * exercise's `Goal` id and `CarePlan.created` the writer was given, so an app
 * can rewrite the same resources. {@link currentPlanOf} picks which of several
 * stored plans to follow, and {@link progressionGoalsToFhir} writes a
 * progression back as the moved `Goal`s alone. Attempts are the exception: `attemptFromFhir` does not read the
 * `focus` / `basedOn` / `subject` references or the stored success flag — the
 * app scopes its Observation search with `based-on=CarePlan/<id>`, so attempts
 * under another plan never reach the domain. No reader throws: each returns
 * its value or a tagged error listing every problem, and a retracted
 * observation reads as `None`, not as a failure.
 *
 * Kept behind the `lifting-core/fhir` subpath so importing the domain from
 * `lifting-core` does not pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export type { AttemptToFhirOptions, ObservationResource } from './attempt.ts'
export { AttemptReadProblem, attemptFromFhir, attemptToFhir, AttemptUnreadable } from './attempt.ts'

export type { LiftingMeasure, LiftingProgressionPartName } from './elements.ts'
export {
  LIFTING_PLAN_CATEGORY_TOKEN,
  LiftingMeasureCode,
  LiftingProgressionPart,
} from './elements.ts'

export type { ExerciseGoalToFhirOptions, GoalResource } from './goal.ts'
export {
  exerciseGoalFromFhir,
  exerciseGoalToFhir,
  GoalReadProblem,
  GoalUnreadable,
} from './goal.ts'

export type { CarePlanResource, PlanResources, PlanToFhirOptions, StoredPlan } from './plan.ts'
export { planFromFhir, PlanReadProblem, PlanUnreadable, planToFhir } from './plan.ts'

export type { FollowedPlan } from './stored-plan.ts'
export { currentPlanOf, progressionGoalsToFhir, StoredGoalMissing } from './stored-plan.ts'
