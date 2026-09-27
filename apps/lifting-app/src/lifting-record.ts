import { Array as Arr, Data, type DateTime, Effect, Either, Option, pipe } from 'effect'
import {
  type BundleDecodeError,
  fetchAllResourcePages,
  fetchCarePlanPage,
  fetchGoalPage,
  fetchObservationBasedOnPage,
  type ResourcePageCycleError,
  type ResourcePageRequestError,
} from 'fhir-r4-react/smart'
import type { BatchEntryOutcome, FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { persistBatchBundle } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import type Client from 'fhirclient/lib/Client'
import type { ExerciseAttempt, Plan } from 'lifting-core'
import {
  attemptFromFhir,
  attemptToFhir,
  currentPlanOf,
  LIFTING_PLAN_CATEGORY_TOKEN,
  planFromFhir,
  planToFhir,
  progressionGoalsToFhir,
  type StoredGoalMissing,
  type StoredPlan,
} from 'lifting-core/fhir'
import { nanoid } from 'nanoid'

/** Everything the plan read found for a patient — the plan followed and what could not be used. */
interface PlanRecord {
  /** The plan followed: `currentPlanOf` over every readable lifting plan. */
  readonly current: Option.Option<StoredPlan>
  /** Active lifting `CarePlan`s that `planFromFhir` could not read, with their goals. */
  readonly unreadablePlanCount: number
  /** Readable active lifting plans other than {@link PlanRecord.current}, which the app does not follow. */
  readonly otherPlanCount: number
  /** `CarePlan` and `Goal` entries the server sent that did not decode as FHIR at all. */
  readonly droppedEntryCount: number
}

/** Every attempt logged against one plan, and the observations that did not read as one. */
interface AttemptRecord {
  /** The attempts `attemptFromFhir` read, in server order. */
  readonly attempts: readonly ExerciseAttempt[]
  /** Retracted observations (`cancelled` / `entered-in-error`): legitimately skipped. */
  readonly retractedCount: number
  /** Observations that did not decode, or decoded but did not read as an attempt. */
  readonly unreadableCount: number
}

/** A failed read: a page request, a page that is not a bundle, or a `next` link that loops. */
type ReadFailure = ResourcePageRequestError | BundleDecodeError | ResourcePageCycleError

/**
 * Some writes in a batch were not accepted — any entry the server answered
 * with a non-2xx status, or no status at all.
 */
class WritesRejected extends Data.TaggedError('WritesRejected')<{
  /** A one-line summary of every rejected write, for the view's error banner. */
  readonly message: string
  /** Each rejected entry's outcome, in submit order. */
  readonly rejected: Arr.NonEmptyReadonlyArray<BatchEntryOutcome>
}> {}

/**
 * The ids — and the creation time — one plan save writes under.
 *
 * @remarks
 * Made once, when a draft is first saved, and handed to every retry of that
 * save: a batch's entries land independently, so a save that partly landed is
 * completed by writing the same ids again, never by minting new ones beside
 * what already landed (which would leave an unreadable `CarePlan` active on
 * the record for good).
 */
interface PlanWriteIds {
  /** The `CarePlan.id`: the stored plan's, or minted for a new plan. */
  readonly carePlanId: string
  /** `CarePlan.created`: the stored plan's, or the first save's time. */
  readonly created: DateTime.Utc
  /**
   * Each exercise's `Goal.id`: the stored ones, plus one minted per new
   * exercise the first time a save asks for it — then kept, so a retry agrees.
   */
  readonly goalIdByExerciseId: Map<string, string>
}

/**
 * The ids one logged session's `Observation`s are written under.
 *
 * @remarks
 * Made when "Log session" hands back a session and kept for a retry of that
 * same workout under that same plan, for the reason {@link PlanWriteIds} is:
 * a retry rewrites the observations that already landed instead of
 * duplicating them.
 */
interface SessionWriteIds {
  /** The `CarePlan.id` the session was lifted against. */
  readonly carePlanId: string
  /** The workout the session logged. */
  readonly workoutLabel: string
  /** Each exercise's `Observation.id`, minted the first time a write asks for it. */
  readonly observationIdByExerciseId: Map<string, string>
}

/** The id `ids` holds for `key`, minting (and remembering) one the first time it is asked. */
const idFor = (ids: Map<string, string>, key: string): string => {
  const known = ids.get(key)
  if (known !== undefined) return known
  const minted = nanoid()
  ids.set(key, minted)
  return minted
}

/** A patient's literal reference, as every written resource's `subject`. */
const patientReference = (patientId: string): string => `Patient/${patientId}`

/** A `CarePlan`'s literal reference, as its observations' `based-on`. */
const carePlanReference = (carePlanId: string): string => `CarePlan/${carePlanId}`

/**
 * Read a patient's active lifting plans and their goals, and pick the one the
 * app follows.
 *
 * @param client - The SMART client the searches are issued through
 * @param patientId - The launch's patient
 * @returns The {@link PlanRecord}: the plan followed, and a count of every
 *   plan or entry that could not be used, so a banner can say so
 *
 * @remarks
 * Every page is read: the due workout and each progression decision are made
 * over the whole history, so a partial read would get them wrong. The
 * `CarePlan` search is narrowed to the lifting category, so another feature's
 * care plans are never counted as unreadable lifting plans.
 */
const readPlanRecord = (
  client: Client,
  patientId: string
): Effect.Effect<PlanRecord, ReadFailure> =>
  Effect.gen(function* () {
    const [carePlans, goals] = yield* Effect.all(
      [
        fetchAllResourcePages((cursor) => fetchCarePlanPage(client, cursor), {
          patientId,
          category: LIFTING_PLAN_CATEGORY_TOKEN,
        }),
        fetchAllResourcePages((cursor) => fetchGoalPage(client, cursor), patientId),
      ],
      { concurrency: 2 }
    )
    const [unreadable, readable] = Arr.partitionMap(carePlans.items, (carePlan) =>
      planFromFhir(carePlan, goals.items)
    )
    const { current, others } = currentPlanOf(readable)
    return {
      current,
      unreadablePlanCount: unreadable.length,
      otherPlanCount: others.length,
      droppedEntryCount: carePlans.droppedEntryCount + goals.droppedEntryCount,
    }
  })

/**
 * Read every attempt logged against a plan.
 *
 * @param client - The SMART client the search is issued through
 * @param patientId - The launch's patient
 * @param carePlanId - The plan's `CarePlan.id`; the search is `based-on` it
 * @returns The {@link AttemptRecord}
 */
const readAttemptRecord = (
  client: Client,
  patientId: string,
  carePlanId: string
): Effect.Effect<AttemptRecord, ReadFailure> =>
  Effect.map(
    fetchAllResourcePages((cursor) => fetchObservationBasedOnPage(client, cursor), {
      patientId,
      basedOn: carePlanReference(carePlanId),
    }),
    (observations): AttemptRecord => {
      const [unreadable, read] = Arr.partitionMap(observations.items, attemptFromFhir)
      const attempts = Arr.getSomes(read)
      return {
        attempts,
        retractedCount: read.length - attempts.length,
        unreadableCount: unreadable.length + observations.droppedEntryCount,
      }
    }
  )

/** How one rejected write reads in the banner: its target, status and the server's reasons. */
const describeRejected = (outcome: BatchEntryOutcome): string => {
  const reasons = outcome.issues.map((issue) => issue.text).filter((text) => text !== '')
  const target = `${outcome.target.label}/${outcome.target.id}`
  return reasons.length === 0
    ? `${target} (${outcome.status})`
    : `${target} (${outcome.status}: ${reasons.join('; ')})`
}

/**
 * Write `resources` as one batch `Bundle`, failing with {@link WritesRejected}
 * unless every entry was accepted.
 *
 * @remarks
 * `persistBatchBundle` reports each entry's outcome as data and never fails.
 * Batch entries land independently, so a rejected entry does not undo the
 * others: the caller refetches either way, and retries with the same ids.
 * Every non-2xx entry — including the no-response entries a failed round trip
 * reports — is raised as one error the view can show.
 */
const persistEveryResource = (
  resources: readonly FhirResource[]
): Effect.Effect<void, WritesRejected, FhirR4ResourcesHttpApiClient> =>
  Effect.flatMap(persistBatchBundle(resources), (outcomes) =>
    Arr.match(
      outcomes.filter((outcome) => !outcome.ok),
      {
        onEmpty: () => Effect.void,
        onNonEmpty: (rejected) =>
          Effect.fail(
            new WritesRejected({
              rejected,
              message: `${rejected.length} of ${outcomes.length} writes were rejected: ${rejected
                .map(describeRejected)
                .join(', ')}`,
            })
          ),
      }
    )
  )

/**
 * The ids a save of a plan replacing `stored` (or a new plan, when there is
 * none) writes under.
 *
 * @param stored - The plan the save replaces, if any
 * @param now - The save's time: a new plan's `created`, and a stored plan's
 *   when it was stored without one
 */
const planWriteIdsFor = (stored: StoredPlan | undefined, now: DateTime.Utc): PlanWriteIds =>
  stored === undefined
    ? { carePlanId: nanoid(), created: now, goalIdByExerciseId: new Map() }
    : {
        carePlanId: stored.carePlanId,
        created: Option.getOrElse(stored.created, () => now),
        goalIdByExerciseId: new Map(Object.entries(stored.goalIdByExerciseId)),
      }

/**
 * The resources that save `plan`: its `CarePlan` and one `Goal` per exercise,
 * under `ids`.
 *
 * @param plan - The plan the editor decoded
 * @param ids - The save's ids; a new exercise's goal id is minted into them
 * @param patientId - The launch's patient
 */
const planResources = (
  plan: Plan,
  ids: PlanWriteIds,
  patientId: string
): readonly FhirResource[] => {
  const { carePlan, goals } = planToFhir(plan, {
    carePlanId: ids.carePlanId,
    created: ids.created,
    goalIdFor: (exerciseId) => idFor(ids.goalIdByExerciseId, exerciseId),
    subject: patientReference(patientId),
  })
  return [carePlan, ...goals]
}

/**
 * The `Goal`s that apply a progression — `progressionGoalsToFhir` for this
 * patient.
 *
 * @returns The moved goals, or `StoredGoalMissing` for a moved goal the stored
 *   plan has no id for
 */
const progressionResources = (
  progressed: Plan,
  stored: StoredPlan,
  patientId: string
): Either.Either<readonly FhirResource[], StoredGoalMissing> =>
  progressionGoalsToFhir(stored, progressed, patientReference(patientId))

/** A logged attempt's exercise has no goal in the stored plan, so it has nothing to be `focus`ed on. */
class AttemptGoalMissing extends Data.TaggedError('AttemptGoalMissing')<{
  readonly message: string
}> {}

/** The write ids for a session of `workoutLabel` lifted against `stored`. */
const sessionWriteIdsFor = (stored: StoredPlan, workoutLabel: string): SessionWriteIds => ({
  carePlanId: stored.carePlanId,
  workoutLabel,
  observationIdByExerciseId: new Map(),
})

/**
 * The `Observation`s that log a session: one per attempt under `ids`,
 * `based-on` the stored plan's `CarePlan` and `focus`ed on its exercise's
 * `Goal`.
 *
 * @param sessionAttempts - The attempts the today view built
 * @param ids - The session's ids; each exercise's observation id is minted into them
 * @param stored - The plan the session was lifted against
 * @param patientId - The launch's patient
 * @returns The observations, or {@link AttemptGoalMissing} naming an attempt's
 *   exercise the plan has no stored goal for
 */
const sessionResources = (
  sessionAttempts: readonly ExerciseAttempt[],
  ids: SessionWriteIds,
  stored: StoredPlan,
  patientId: string
): Either.Either<readonly FhirResource[], AttemptGoalMissing> =>
  Either.all(
    sessionAttempts.map((attempt) =>
      pipe(
        Option.fromNullable(stored.goalIdByExerciseId[attempt.exercise.id]),
        Either.fromOption(
          () =>
            new AttemptGoalMissing({
              message: `The plan has no stored goal for ${attempt.exercise.name}.`,
            })
        ),
        Either.map((goalId) =>
          attemptToFhir(attempt, {
            observationId: idFor(ids.observationIdByExerciseId, attempt.exercise.id),
            subject: patientReference(patientId),
            goalId,
            carePlanId: stored.carePlanId,
          })
        )
      )
    )
  )

export {
  AttemptGoalMissing,
  type AttemptRecord,
  persistEveryResource,
  planResources,
  type PlanRecord,
  planWriteIdsFor,
  type PlanWriteIds,
  progressionResources,
  readAttemptRecord,
  readPlanRecord,
  sessionResources,
  sessionWriteIdsFor,
  type SessionWriteIds,
  WritesRejected,
}
