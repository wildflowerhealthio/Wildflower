import { Array as Arr, Either, Option, pipe, Record as EffectRecord } from 'effect'
import { type ExerciseRequest, type Load, TrainingPlanDefinition } from 'lifting-core-js'
import type { JSX, SubmitEvent } from 'react'
import { useId, useState } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, RadioGroup } from 'react-tundraish'

import { useFormState } from '../form/use-form-state.ts'
import { StartingLoadField } from './starting-load-field.tsx'
import { startingLoadFromText, suggestedStartingLoadText } from './starting-load.ts'
import styles from './start-training-plan-definition-view.module.css'

/**
 * A training plan definition to start and the load to start each exercise
 * at: what `ExerciseRequest.makeForEachExercise` (or
 * `changeTrainingPlanDefinition`) needs beside the lifter, the ids the app
 * mints and when.
 */
interface TrainingPlanDefinitionStart {
  /** The training plan definition chosen. */
  readonly trainingPlanDefinition: TrainingPlanDefinition.Type
  /** A starting load for every exercise it runs, by exercise id, each one its rule accepts. */
  readonly startingLoads: ExerciseRequest.StartingLoads
}

interface StartTrainingPlanDefinitionViewProps {
  /**
   * The training plan definitions to choose from, the first chosen to begin
   * with — e.g. `StrongLifts5x5.trainingPlanDefinition(...)` under an id the
   * app minted, or the one the editor just saved. A choice is offered only
   * when there are several.
   */
  readonly trainingPlanDefinitions: Arr.NonEmptyReadonlyArray<TrainingPlanDefinition.Type>
  /**
   * The loads each field begins at, by exercise id — `StrongLifts5x5.STARTING_LOADS`,
   * or the lifter's current loads when restarting; a load in another unit
   * than the exercise's rule is not offered.
   */
  readonly suggestedStartingLoads: ExerciseRequest.StartingLoads
  /** Called with the chosen training plan definition and a starting load for each of its exercises. */
  readonly onStart: (trainingPlanDefinitionStart: TrainingPlanDefinitionStart) => void
  /** The start is being written: the whole form is disabled until it settles. */
  readonly pending?: boolean
  /**
   * Why the last write failed — e.g. a mutation's `error`, passed straight
   * through — shown in an `ErrorBanner`; `null` or absent when it didn't.
   */
  readonly error?: unknown
}

/** The choices of a {@link StartTrainingPlanDefinitionView} as the lifter makes them. */
interface StartForm {
  /** The id of the training plan definition chosen. */
  readonly chosenPlanDefinitionId: string
  /** The text of each starting load field the lifter has edited, by exercise id. */
  readonly loadTextByExerciseId: EffectRecord.ReadonlyRecord<string, string>
}

/**
 * The **start-program view**: choose a training plan definition and enter the
 * load to start each of its exercises at.
 *
 * @remarks
 * Each field is the amount in its exercise's rule's unit. Its text is checked
 * as `lifting-core-js` checks a starting load
 * (`TrainingPlanDefinition.ProgressionRule.startingLoadSchema` — in the
 * rule's unit, at or above its minimum load); the first start that finds a
 * problem shows each one under its field with a `role="alert"` summary, and
 * from then on the problems track the form. `onStart` only ever receives a
 * load per exercise that `ExerciseRequest.makeForEachExercise` accepts.
 *
 * A load entered for an exercise is kept across a change of choice, so two
 * training plan definitions that share an exercise share its field.
 */
const StartTrainingPlanDefinitionView = ({
  trainingPlanDefinitions,
  suggestedStartingLoads,
  onStart,
  pending = false,
  error,
}: StartTrainingPlanDefinitionViewProps): JSX.Element => {
  const headingId = useId()
  const choiceName = useId()
  const form = useFormState<StartForm>(() => ({
    chosenPlanDefinitionId: Arr.headNonEmpty(trainingPlanDefinitions).id,
    loadTextByExerciseId: {},
  }))
  const [startAttempted, setStartAttempted] = useState(false)

  const trainingPlanDefinition = pipe(
    Arr.findFirst(trainingPlanDefinitions, ({ id }) => id === form.value.chosenPlanDefinitionId),
    Option.getOrElse(() => Arr.headNonEmpty(trainingPlanDefinitions))
  )
  const rows = TrainingPlanDefinition.exercisesOf(trainingPlanDefinition).map(
    (trainingPlanDefinitionExercise) => {
      const exerciseId = TrainingPlanDefinition.Exercise.exerciseIdOf(
        trainingPlanDefinitionExercise
      )
      const text = Option.getOrElse(
        EffectRecord.get(form.value.loadTextByExerciseId, exerciseId),
        () => suggestedStartingLoadText({ trainingPlanDefinitionExercise, suggestedStartingLoads })
      )
      return {
        exerciseId,
        trainingPlanDefinitionExercise,
        text,
        startingLoad: startingLoadFromText({ text, trainingPlanDefinitionExercise }),
      }
    }
  )
  const problemCount = rows.filter(({ startingLoad }) => Either.isLeft(startingLoad)).length

  const start = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setStartAttempted(true)
    Either.match(
      Either.all(
        rows.map(({ exerciseId, startingLoad }) =>
          Either.map(startingLoad, (load): readonly [string, Load.Type] => [exerciseId, load])
        )
      ),
      {
        onLeft: () => undefined,
        onRight: (startingLoadEntries) => {
          onStart({
            trainingPlanDefinition,
            startingLoads: Object.fromEntries(startingLoadEntries),
          })
        },
      }
    )
  }

  return (
    <form
      className={styles['start-training-plan-definition-view']}
      aria-labelledby={headingId}
      noValidate
      onSubmit={start}
    >
      <fieldset className={styles['start-training-plan-definition-view__body']} disabled={pending}>
        <h2
          id={headingId}
          className={cn('text-heading-6', styles['start-training-plan-definition-view__heading'])}
        >
          Start a program
        </h2>
        {trainingPlanDefinitions.length > 1 ? (
          <RadioGroup
            name={choiceName}
            legend="Program"
            value={trainingPlanDefinition.id}
            onChange={(planDefinitionId) => {
              form.set('chosenPlanDefinitionId', planDefinitionId)
            }}
            options={trainingPlanDefinitions.map(({ id, title }) => ({ value: id, label: title }))}
          />
        ) : (
          <p className={cn('text-body-2', styles['start-training-plan-definition-view__title'])}>
            {trainingPlanDefinition.title}
          </p>
        )}
        <fieldset className={styles['start-training-plan-definition-view__loads']}>
          <legend className="text-label-2">Starting loads</legend>
          {rows.map(({ exerciseId, trainingPlanDefinitionExercise, text, startingLoad }) => (
            <StartingLoadField
              key={exerciseId}
              trainingPlanDefinitionExercise={trainingPlanDefinitionExercise}
              text={text}
              startingLoad={startingLoad}
              showProblem={startAttempted}
              onChange={(loadText) => {
                form.field('loadTextByExerciseId').set(exerciseId, loadText)
              }}
            />
          ))}
        </fieldset>
        {startAttempted && problemCount > 0 ? (
          <p
            role="alert"
            className={cn('text-body-3', styles['start-training-plan-definition-view__summary'])}
          >
            {problemCount === 1
              ? '1 starting load to fix — see the highlighted field.'
              : `${problemCount} starting loads to fix — see the highlighted fields.`}
          </p>
        ) : null}
        <ErrorBanner error={error} />
        <div className={styles['start-training-plan-definition-view__actions']}>
          <button type="submit" className="button-2 filled">
            {pending ? 'Starting…' : 'Start program'}
          </button>
        </div>
      </fieldset>
    </form>
  )
}

export { StartTrainingPlanDefinitionView }
export type { StartTrainingPlanDefinitionViewProps, TrainingPlanDefinitionStart }
