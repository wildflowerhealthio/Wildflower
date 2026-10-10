import type { ExerciseTextField } from './training-plan-definition-draft.ts'

/**
 * Where a problem sits in a draft, as a key into {@link DraftProblems}: the
 * title, the day list as a whole, a day's label or exercise list, one field
 * of an exercise row, or an exercise row as a whole.
 */
const DraftPath = {
  title: 'title',
  /** The day list as a whole ("add at least one day"). */
  days: 'days',
  dayLabel: (dayKey: string): string => `day/${dayKey}/label`,
  /** A day's exercise list as a whole ("add at least one exercise"). */
  dayExercises: (dayKey: string): string => `day/${dayKey}/exercises`,
  exerciseField: (exerciseKey: string, field: ExerciseTextField): string =>
    `exercise/${exerciseKey}/${field}`,
  /** An exercise row as a whole (one exercise defined two ways). */
  exercise: (exerciseKey: string): string => `exercise/${exerciseKey}`,
} as const

/**
 * Every reason a draft is not yet a training plan definition, keyed by
 * {@link DraftPath}, each a sentence to show under its field — the first
 * found for each.
 */
type DraftProblems = ReadonlyMap<string, string>

export { DraftPath }
export type { DraftProblems }
