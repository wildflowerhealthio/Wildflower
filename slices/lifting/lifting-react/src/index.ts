/**
 * Browser UI for strength-training plans: the screens a lifting app shows.
 * {@link PlannedWorkoutView} is the workout due, the reps of each set entered
 * and submitted at once; {@link SubmittedWorkoutView} what submitting it did
 * to each exercise's load; {@link StartTrainingPlanDefinitionView} starts a
 * training plan definition at a load per exercise;
 * {@link TrainingPlanDefinitionEditor} creates or edits one (or seeds one from
 * StrongLifts 5×5); and {@link WorkoutHistoryView} lists the completed
 * workouts.
 *
 * Components take `lifting-core`'s narrowed FHIR resources as plain props and
 * hand back callbacks; they never fetch, mint an id or read the clock unless
 * passed one. Every decision — the workout due, whether an attempt met its
 * `ExerciseRequest`, where a load goes next — comes from `lifting-core`, and
 * every value is read with its getters.
 *
 * @packageDocumentation
 */
export {
  PlannedWorkoutView,
  type PlannedWorkoutViewProps,
  type WorkoutSubmission,
} from './planned-workout-view.tsx'
export {
  StartTrainingPlanDefinitionView,
  type StartTrainingPlanDefinitionViewProps,
  type TrainingPlanDefinitionStart,
} from './start-training-plan-definition-view.tsx'
export { SubmittedWorkoutView, type SubmittedWorkoutViewProps } from './submitted-workout-view.tsx'
export {
  TrainingPlanDefinitionEditor,
  type TrainingPlanDefinitionEditorProps,
} from './training-plan-definition-editor.tsx'
export { WorkoutHistoryView, type WorkoutHistoryViewProps } from './workout-history-view.tsx'
