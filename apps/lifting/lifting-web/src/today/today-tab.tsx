import { Array as Arr, Either, Option } from 'effect'
import { type ExerciseRequest, PlannedWorkout } from 'lifting-core-js'
import { PlannedWorkoutView, SubmittedWorkoutView, type WorkoutSubmission } from 'lifting-react'
import { type JSX, useMemo, useState } from 'react'
import { ErrorBanner } from 'react-tundraish'

import { now } from '../clock.ts'
import { workoutIdMinter } from '../ids/workout-id-minter.ts'
import type { CurrentTraining } from '../record/training-record.ts'
import { type LiftingSession, subjectOf } from '../session/lifting-session.ts'
import { useLiftingWrite, useLiftingWriting } from '../session/use-lifting-write.ts'
import { currentLoadsOf } from '../start-program/current-loads.ts'
import { StartProgram } from '../start-program/start-program.tsx'
import { submittedWorkoutResources } from './submitted-workout-resources.ts'
import styles from './today-tab.module.css'

/**
 * What one submission writes from, fixed at its first attempt so a retry
 * writes the same resources: the planned workout submitted, and the `mintId`
 * that names its resources.
 */
interface WorkoutAttempt {
  readonly plannedWorkout: PlannedWorkout.Type
  readonly mintId: (idToMint: PlannedWorkout.IdToMint) => string
}

/** Props for {@link TodayTab}. */
interface TodayTabProps {
  readonly session: LiftingSession
  /** The lifter's current program, as the record read found it. */
  readonly currentTraining: CurrentTraining
  /** Every active `ExerciseRequest` of the lifter's, which a restart revokes. */
  readonly activeExerciseRequests: readonly ExerciseRequest.Type[]
}

/**
 * The workout due: `PlannedWorkout.make` over the current program, shown by
 * `PlannedWorkoutView`; a submission goes through `PlannedWorkout.submit` and
 * everything it returns is written in one batch, then shown by
 * `SubmittedWorkoutView` until the lifter moves on.
 *
 * @remarks
 * The first attempt at a submission fixes the planned workout and its ids
 * ({@link WorkoutAttempt}); while it is unwritten the view keeps showing that
 * planned workout — not the one a refetch after a partly landed write would
 * plan — and a retry submits it again under the same ids, overwriting what
 * landed.
 *
 * When the program has an exercise of the day due with no active
 * `ExerciseRequest`, or several, the refusal is shown above a restart of the
 * program at the lifter's current loads.
 */
const TodayTab = ({
  session,
  currentTraining,
  activeExerciseRequests,
}: TodayTabProps): JSX.Element => {
  const workoutWrite = useLiftingWrite(session, 'workout')
  const writing = useLiftingWriting(session)
  const [workoutAttempt, setWorkoutAttempt] = useState<Option.Option<WorkoutAttempt>>(Option.none())
  const [submitRefusal, setSubmitRefusal] = useState<unknown>(null)
  const [submitted, setSubmitted] = useState<Option.Option<PlannedWorkout.Submitted>>(Option.none())
  const plannedWorkout = useMemo(() => PlannedWorkout.make(currentTraining), [currentTraining])

  if (Option.isSome(submitted)) {
    return (
      <div className={styles['today-tab__submitted']}>
        <SubmittedWorkoutView submitted={submitted.value} />
        <button
          type="button"
          className="button-2 filled"
          onClick={() => {
            setSubmitted(Option.none())
          }}
        >
          Next workout
        </button>
      </div>
    )
  }

  const submit = (
    attempt: WorkoutAttempt,
    { setRepsByExerciseId, start, end }: WorkoutSubmission
  ): void => {
    setWorkoutAttempt(Option.some(attempt))
    Either.match(
      PlannedWorkout.submit({
        plannedWorkout: attempt.plannedWorkout,
        subject: subjectOf(session),
        start,
        end,
        setRepsByExerciseId,
        mintId: attempt.mintId,
      }),
      {
        onLeft: setSubmitRefusal,
        onRight: (submittedWorkout) => {
          setSubmitRefusal(null)
          workoutWrite.mutate(submittedWorkoutResources(submittedWorkout), {
            onSuccess: () => {
              setWorkoutAttempt(Option.none())
              setSubmitted(Option.some(submittedWorkout))
            },
          })
        },
      }
    )
  }

  // A submission under way keeps showing the planned workout it submitted.
  const shownPlannedWorkout = Option.match(workoutAttempt, {
    onNone: () => plannedWorkout,
    onSome: (attempt) => Either.right(attempt.plannedWorkout),
  })
  if (Either.isLeft(shownPlannedWorkout)) {
    return (
      <>
        <ErrorBanner error={shownPlannedWorkout.left} />
        <StartProgram
          session={session}
          trainingPlanDefinitions={Arr.of(currentTraining.trainingPlanDefinition)}
          storesTrainingPlanDefinition={false}
          suggestedStartingLoads={currentLoadsOf(activeExerciseRequests)}
          activeExerciseRequests={activeExerciseRequests}
        />
      </>
    )
  }
  return (
    <PlannedWorkoutView
      plannedWorkout={shownPlannedWorkout.right}
      now={now}
      onSubmit={(workoutSubmission) => {
        submit(
          Option.getOrElse(workoutAttempt, (): WorkoutAttempt => ({
            plannedWorkout: shownPlannedWorkout.right,
            mintId: workoutIdMinter(shownPlannedWorkout.right),
          })),
          workoutSubmission
        )
      }}
      pending={writing}
      error={submitRefusal ?? workoutWrite.error}
    />
  )
}

export { TodayTab, type TodayTabProps }
