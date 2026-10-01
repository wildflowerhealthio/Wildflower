import { Option } from 'effect'
import type { JSX } from 'react'
import { PartialBanner } from 'react-tundraish'

import { countOf } from './count-of.ts'
import type { TrainingRecord } from './training-record.ts'
import { UnreadableNotice } from './unreadable-notice.tsx'

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

export { TrainingRecordNotices }
