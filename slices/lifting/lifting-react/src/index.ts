/**
 * Browser UI for strength-training plans: the screens a lifting app's tabs
 * switch between. {@link TodayView} shows the workout due and logs a session
 * set by set, {@link ProgressionReview} shows the increment / hold / deload
 * decision for each lift and applies it, {@link PlanEditor} creates or edits a
 * plan (or starts one from StrongLifts 5×5), and {@link HistoryView} lists the
 * logged sessions by day.
 *
 * Components take plain props and callbacks and never fetch: the app loads
 * and saves through `lifting-core/fhir`. Every decision — which workout is
 * due, whether a lift succeeded, where its load goes next — comes from
 * `lifting-core`; nothing here re-derives one.
 *
 * @packageDocumentation
 */
export { HistoryView, type HistoryViewProps } from './history-view.tsx'
export { PlanEditor, type PlanEditorProps } from './plan-editor.tsx'
export { ProgressionReview, type ProgressionReviewProps } from './progression-review.tsx'
export { TodayView, type TodayViewProps } from './today-view.tsx'
