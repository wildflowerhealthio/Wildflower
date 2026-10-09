import { Array as Arr, Option } from 'effect'
import type { ExerciseRequest, TrainingPlanDefinition } from 'lifting-core-js'
import { TrainingPlanDefinitionEditor } from 'lifting-react'
import { type JSX, useState } from 'react'

import { mintResourceId } from '../ids/mint-resource-id.ts'
import type { LiftingSession } from '../session/lifting-session.ts'
import { useLiftingWrite, useLiftingWriting } from '../session/use-lifting-write.ts'
import { currentLoadsOf } from '../start-program/current-loads.ts'
import { StartProgram } from '../start-program/start-program.tsx'

/** Props for {@link PlanTab}. */
interface PlanTabProps {
  readonly session: LiftingSession
  /** The training plan definition the lifter follows, which the editor begins from; `None` for an empty form. */
  readonly currentTrainingPlanDefinition: Option.Option<TrainingPlanDefinition.Type>
  /** Every active `ExerciseRequest` of the lifter's: their current loads, revoked by the start. */
  readonly activeExerciseRequests: readonly ExerciseRequest.Type[]
  /** Called once the saved training plan definition has been started. */
  readonly onStarted: () => void
}

/**
 * Edit the program: `TrainingPlanDefinitionEditor` over the current training
 * plan definition (or an empty form, which offers StrongLifts 5×5); "Save"
 * writes the training plan definition it made, then {@link StartProgram}
 * starts it at the lifter's current loads.
 *
 * @remarks
 * Every save is a new `PlanDefinition` under an id minted when the tab opens,
 * never the current one rewritten: the closed `ExerciseRequest`s and the
 * workouts already performed instantiate the current one's url, and keep
 * reading against it. A retry of a failed save writes the same id.
 */
const PlanTab = ({
  session,
  currentTrainingPlanDefinition,
  activeExerciseRequests,
  onStarted,
}: PlanTabProps): JSX.Element => {
  const trainingPlanDefinitionWrite = useLiftingWrite(session, 'training-plan-definition')
  const writing = useLiftingWriting(session)
  const [planDefinitionId] = useState(mintResourceId)
  const [savedTrainingPlanDefinition, setSavedTrainingPlanDefinition] = useState<
    Option.Option<TrainingPlanDefinition.Type>
  >(Option.none())

  if (Option.isSome(savedTrainingPlanDefinition)) {
    return (
      <StartProgram
        session={session}
        trainingPlanDefinitions={Arr.of(savedTrainingPlanDefinition.value)}
        storesTrainingPlanDefinition={false}
        suggestedStartingLoads={currentLoadsOf(activeExerciseRequests)}
        activeExerciseRequests={activeExerciseRequests}
        onStarted={onStarted}
      />
    )
  }
  return (
    <TrainingPlanDefinitionEditor
      initial={Option.getOrNull(currentTrainingPlanDefinition)}
      planDefinitionId={planDefinitionId}
      onSave={(trainingPlanDefinition) => {
        trainingPlanDefinitionWrite.mutate([trainingPlanDefinition], {
          onSuccess: () => {
            setSavedTrainingPlanDefinition(Option.some(trainingPlanDefinition))
          },
        })
      }}
      pending={writing}
      error={trainingPlanDefinitionWrite.error}
    />
  )
}

export { PlanTab, type PlanTabProps }
