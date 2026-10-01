import { Option } from 'effect'
import { sentenceJoin } from 'kitchen-sink'
import type { JSX } from 'react'
import { PartialBanner } from 'react-tundraish'

import type { TrainingRecord, UnreadableCounts } from './lifting-record.ts'

/** `count` with the noun agreeing with it: `1 set`, `2 sets`. */
const countOf = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`

/** How each lifting type is named in the notice, singular and plural, in the order it is listed. */
const NOUNS: readonly {
  readonly type: keyof UnreadableCounts
  readonly singular: string
  readonly plural: string
}[] = [
  { type: 'trainingPlanDefinitions', singular: 'program', plural: 'programs' },
  { type: 'exerciseRequests', singular: 'exercise request', plural: 'exercise requests' },
  { type: 'workoutProcedures', singular: 'workout', plural: 'workouts' },
  { type: 'exerciseSetObservations', singular: 'set', plural: 'sets' },
]

/**
 * What a read found on the record but could not read, said rather than
 * dropped: `1 workout and 2 sets on your record could not be read and are
 * left out.` Nothing when everything read.
 */
const UnreadableNotice = ({
  unreadable,
}: {
  readonly unreadable: UnreadableCounts
}): JSX.Element | null => {
  const parts = NOUNS.flatMap(({ type, singular, plural }) =>
    unreadable[type] === 0 ? [] : [countOf(unreadable[type], singular, plural)]
  )
  if (parts.length === 0) return null
  const total = NOUNS.reduce((sum, { type }) => sum + unreadable[type], 0)
  return (
    <PartialBanner>
      {sentenceJoin(parts)} on your record could not be read and {total === 1 ? 'is' : 'are'} left
      out.
    </PartialBanner>
  )
}

/**
 * What the training record holds but the screens do not follow: active
 * `ExerciseRequest`s of another program, a program that could not be found,
 * and every resource that could not be read.
 */
const TrainingRecordNotices = ({
  trainingRecord,
}: {
  readonly trainingRecord: TrainingRecord
}): JSX.Element => (
  <>
    {Option.isSome(trainingRecord.missingTrainingPlanDefinitionUrl) && (
      <PartialBanner>
        Your exercise requests follow a program (
        {trainingRecord.missingTrainingPlanDefinitionUrl.value}) that could not be found. Start a
        program to replace them.
      </PartialBanner>
    )}
    {trainingRecord.otherActiveExerciseRequestCount > 0 && (
      <PartialBanner>
        {countOf(
          trainingRecord.otherActiveExerciseRequestCount,
          'active exercise request follows',
          'active exercise requests follow'
        )}{' '}
        another program and {trainingRecord.otherActiveExerciseRequestCount === 1 ? 'is' : 'are'}{' '}
        not shown.
      </PartialBanner>
    )}
    <UnreadableNotice unreadable={trainingRecord.unreadable} />
  </>
)

export { TrainingRecordNotices, UnreadableNotice }
