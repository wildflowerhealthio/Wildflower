import { Array as Arr, Data, DateTime, Either, Option, Order, Record } from 'effect'

import type { Plan } from '../plan.ts'
import { exerciseGoalToFhir, type GoalResource } from './goal.ts'
import type { StoredPlan } from './plan.ts'

/** The plan an app follows among the stored plans it read, and the ones it does not. */
interface FollowedPlan {
  /** The plan followed: the one most recently `created`, or none when there are none. */
  readonly current: Option.Option<StoredPlan>
  /** Every other stored plan, in the order they rank after {@link FollowedPlan.current}. */
  readonly others: readonly StoredPlan[]
}

/** Newest `created` first; a plan with no `created` after every dated one. */
const byCreatedNewestFirst: Order.Order<StoredPlan> = Order.mapInput(
  Order.reverse(Option.getOrder(DateTime.Order)),
  (stored: StoredPlan) => stored.created
)

/**
 * Which of several stored plans to follow: the most recently `created`.
 *
 * @param storedPlans - The plans read, in the order they were read
 * @returns The plan followed and the rest, newest first
 *
 * @remarks
 * A plan with no `created` ranks after every dated one — nothing says when it
 * was made. Plans that tie (the same `created`, or none) keep their input
 * order, so a caller's order (the server's) decides between them.
 */
const currentPlanOf = (storedPlans: readonly StoredPlan[]): FollowedPlan => {
  const ranked = Arr.sort(storedPlans, byCreatedNewestFirst)
  return { current: Arr.head(ranked), others: ranked.slice(1) }
}

/**
 * A progressed goal has no `Goal` id in the stored plan, so there is nowhere
 * to write it back to.
 */
class StoredGoalMissing extends Data.TaggedError('StoredGoalMissing')<{
  /** The exercises whose goal moved but has no stored `Goal` id. */
  readonly exerciseIds: Arr.NonEmptyReadonlyArray<string>
}> {
  override get message(): string {
    return `no stored goal for ${this.exerciseIds.join(', ')}`
  }
}

/**
 * The `Goal`s that apply a progression: the progressed plan's goal for each
 * exercise whose load moved, under the id the stored plan keeps it at.
 *
 * @param stored - The plan as last persisted
 * @param progressed - `progressPlan`'s result for that plan
 * @param subject - The patient the plan is for, as a literal reference (`Patient/p-1`)
 * @returns The moved goals as `Goal`s, or {@link StoredGoalMissing} naming
 *   every moved exercise the stored plan has no `Goal` id for
 *
 * @remarks
 * A progression step only moves loads, so a goal whose load held is already
 * stored as it is, and the `CarePlan` (goal references and activities) is
 * unchanged — neither is rewritten.
 */
const progressionGoalsToFhir = (
  stored: StoredPlan,
  progressed: Plan,
  subject: string
): Either.Either<readonly GoalResource[], StoredGoalMissing> => {
  const moved = Record.toEntries(progressed.goalsByExerciseId).filter(
    ([exerciseId, goal]) => stored.plan.goalsByExerciseId[exerciseId]?.loadLb !== goal.loadLb
  )
  const [unstored, writable] = Arr.partitionMap(moved, ([exerciseId, goal]) =>
    Either.fromNullable(stored.goalIdByExerciseId[exerciseId], () => exerciseId).pipe(
      Either.map((goalId) => exerciseGoalToFhir(goal, { goalId, subject }))
    )
  )
  return Arr.match(unstored, {
    onEmpty: () => Either.right(writable),
    onNonEmpty: (exerciseIds) => Either.left(new StoredGoalMissing({ exerciseIds })),
  })
}

export { currentPlanOf, progressionGoalsToFhir, StoredGoalMissing }
export type { FollowedPlan }
