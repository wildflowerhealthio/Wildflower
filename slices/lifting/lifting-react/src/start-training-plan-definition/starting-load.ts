import { Either, Option, pipe, Record as EffectRecord, Schema } from 'effect'
import { type ExerciseRequest, Load, TrainingPlanDefinition } from 'lifting-core'

import { enteredNumber, numberText } from '../form/entered-number.ts'
import { parseIssuesOf } from '../form/parse-issues.ts'

/**
 * The text a starting load field begins with: the suggested load's amount
 * when there is one the exercise's rule moves (in its unit), else blank.
 */
const suggestedStartingLoadText = ({
  trainingPlanDefinitionExercise,
  suggestedStartingLoads,
}: {
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
  readonly suggestedStartingLoads: ExerciseRequest.StartingLoads
}): string =>
  pipe(
    EffectRecord.get(
      suggestedStartingLoads,
      TrainingPlanDefinition.Exercise.exerciseIdOf(trainingPlanDefinitionExercise)
    ),
    Option.filter(
      Schema.is(
        TrainingPlanDefinition.ProgressionRule.movableLoadSchema(
          TrainingPlanDefinition.Exercise.progressionRuleOf(trainingPlanDefinitionExercise)
        )
      )
    ),
    Option.match({ onNone: () => '', onSome: (load) => numberText(Load.valueOf(load)) })
  )

/**
 * A starting load field's text as the `Load` an exercise may start at, in its
 * rule's unit — or the problem to show under the field: the text spells no
 * number, or `lifting-core` refuses the load
 * (`TrainingPlanDefinition.ProgressionRule.startingLoadSchema`).
 */
const startingLoadFromText = ({
  text,
  trainingPlanDefinitionExercise,
}: {
  readonly text: string
  readonly trainingPlanDefinitionExercise: TrainingPlanDefinition.Exercise.Type
}): Either.Either<Load.Type, string> => {
  const progressionRule = TrainingPlanDefinition.Exercise.progressionRuleOf(
    trainingPlanDefinitionExercise
  )
  return Either.flatMap(enteredNumber(text), (value) =>
    pipe(
      Load.make({ value, unit: TrainingPlanDefinition.ProgressionRule.unitOf(progressionRule) }),
      Either.flatMap(
        Schema.validateEither(
          TrainingPlanDefinition.ProgressionRule.startingLoadSchema(progressionRule),
          { errors: 'all' }
        )
      ),
      Either.mapLeft((parseError) =>
        parseIssuesOf(parseError)
          .map((issue) => issue.message)
          .join('; ')
      )
    )
  )
}

export { startingLoadFromText, suggestedStartingLoadText }
