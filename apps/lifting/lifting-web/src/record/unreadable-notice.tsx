import { sentenceJoin } from '@wildflowerhealthio/kitchen-sink'
import { PartialBanner } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

import { countOf } from './count-of.ts'
import type { UnreadableCounts } from './unreadable-counts.ts'

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

export { UnreadableNotice }
