import { type Array as Arr, type DateTime, Either, Option } from 'effect'
import { ExerciseRequest, type TrainingPlanDefinition } from 'lifting-core'
import { StartTrainingPlanDefinitionView, type TrainingPlanDefinitionStart } from 'lifting-react'
import { type JSX, useState } from 'react'

import { now } from './clock.ts'
import {
  type LiftingSession,
  subjectOf,
  useLiftingWrite,
  useLiftingWriting,
} from './lifting-session.ts'
import { trainingPlanDefinitionChangeResources } from './lifting-writes.ts'
import { serviceRequestIdMinter } from './mint-ids.ts'

/**
 * What one start writes from, fixed at its first attempt so a retry writes the
 * same resources: the `ExerciseRequest`s it revokes, the ids of those it
 * starts, and when they are issued.
 */
interface StartAttempt {
  readonly activeExerciseRequests: readonly ExerciseRequest.Type[]
  readonly mintServiceRequestId: (exerciseId: string) => string
  readonly authoredOn: DateTime.Utc
}

/** Props for {@link StartProgram}. */
interface StartProgramProps {
  readonly session: LiftingSession
  /** The training plan definitions to choose among, the first chosen to begin with. */
  readonly trainingPlanDefinitions: Arr.NonEmptyReadonlyArray<TrainingPlanDefinition.Type>
  /**
   * Whether the training plan definitions are not stored yet (a template
   * minted here), so the start writes the one chosen in the same batch.
   */
  readonly storesTrainingPlanDefinition: boolean
  /** The loads each starting-load field begins at, by exercise id. */
  readonly suggestedStartingLoads: ExerciseRequest.StartingLoads
  /** The lifter's active `ExerciseRequest`s, every one revoked by the start. */
  readonly activeExerciseRequests: readonly ExerciseRequest.Type[]
  /** Called once the start has landed and the record has been read again. */
  readonly onStarted?: () => void
}

/**
 * Start (or restart) a training plan definition: `StartTrainingPlanDefinitionView`
 * hands back the training plan definition and a starting load per exercise,
 * `ExerciseRequest.changeTrainingPlanDefinition` revokes every active
 * `ExerciseRequest` and starts one per exercise, and all of it is written in
 * one batch.
 *
 * @remarks
 * The first attempt fixes what the start writes from ({@link StartAttempt}),
 * and a retry after a failed write reuses it: the same requests revoked and
 * the same ids started, so what already landed is overwritten rather than
 * duplicated — and a request the failed write started is not revoked by the
 * retry.
 */
const StartProgram = ({
  session,
  trainingPlanDefinitions,
  storesTrainingPlanDefinition,
  suggestedStartingLoads,
  activeExerciseRequests,
  onStarted,
}: StartProgramProps): JSX.Element => {
  const startWrite = useLiftingWrite(session, 'start')
  const writing = useLiftingWriting(session)
  const [startAttempt, setStartAttempt] = useState<Option.Option<StartAttempt>>(Option.none())
  const [startRefusal, setStartRefusal] = useState<unknown>(null)

  const start = ({ trainingPlanDefinition, startingLoads }: TrainingPlanDefinitionStart): void => {
    const attempt = Option.getOrElse(startAttempt, (): StartAttempt => ({
      activeExerciseRequests,
      mintServiceRequestId: serviceRequestIdMinter(),
      authoredOn: now(),
    }))
    setStartAttempt(Option.some(attempt))
    Either.match(
      ExerciseRequest.changeTrainingPlanDefinition({
        exerciseRequests: attempt.activeExerciseRequests,
        subject: subjectOf(session),
        trainingPlanDefinition,
        startingLoads,
        mintServiceRequestId: attempt.mintServiceRequestId,
        authoredOn: attempt.authoredOn,
      }),
      {
        onLeft: setStartRefusal,
        onRight: (trainingPlanDefinitionChange) => {
          setStartRefusal(null)
          startWrite.mutate(
            trainingPlanDefinitionChangeResources({
              unstoredTrainingPlanDefinition: storesTrainingPlanDefinition
                ? Option.some(trainingPlanDefinition)
                : Option.none(),
              trainingPlanDefinitionChange,
            }),
            {
              onSuccess: () => {
                setStartAttempt(Option.none())
                onStarted?.()
              },
            }
          )
        },
      }
    )
  }

  return (
    <StartTrainingPlanDefinitionView
      trainingPlanDefinitions={trainingPlanDefinitions}
      suggestedStartingLoads={suggestedStartingLoads}
      onStart={start}
      pending={writing}
      error={startRefusal ?? startWrite.error}
    />
  )
}

export { StartProgram, type StartProgramProps }
