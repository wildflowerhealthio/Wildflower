import { Either } from 'effect'
import { ExerciseConcept, type Load, TrainingPlanDefinition } from 'lifting-core-js'
import type { JSX } from 'react'
import { TextField } from 'react-tundraish'

import { problemDescription } from '../form/problem-description.tsx'
import { formatUnit } from '../load-format.ts'

/**
 * The starting load of one exercise of the training plan definition being
 * started: the amount in its rule's unit, labelled with the exercise and
 * unit, e.g. `"Squat (lb)"`, with its problem under it once shown.
 */
const StartingLoadField = ({
  trainingPlanDefinitionExercise,
  text,
  startingLoad,
  showProblem,
  onChange,
}: {
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
  /** The field's text. */
  readonly text: string
  /** The text as the load the exercise may start at, or its problem. */
  readonly startingLoad: Either.Either<Load.Type, string>
  /** Whether a problem is shown under the field: once a start was attempted. */
  readonly showProblem: boolean
  readonly onChange: (text: string) => void
}): JSX.Element => (
  <TextField
    label={`${ExerciseConcept.nameOf(
      TrainingPlanDefinition.Exercise.exerciseConceptOf(trainingPlanDefinitionExercise)
    )} (${formatUnit(
      TrainingPlanDefinition.ProgressionRule.unitOf(
        TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
      )
    )})`}
    value={text}
    inputMode="decimal"
    onChange={onChange}
    description={problemDescription(
      showProblem && Either.isLeft(startingLoad) ? startingLoad.left : undefined
    )}
  />
)

export { StartingLoadField }
