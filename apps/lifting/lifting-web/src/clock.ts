import { DateTime } from 'effect'

/** The app's one clock: a workout's start and end, and when an `ExerciseRequest` is issued. */
const now = (): DateTime.Utc => DateTime.unsafeNow()

export { now }
