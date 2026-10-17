import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { LoadingLine, ReadFailureLine } from '@wildflowerhealthio/smart-app-react'
import { Effect, Match } from 'effect'
import { type JSX, useMemo } from 'react'

import { TrainingRecordNotices } from '../../../record/training-record-notices.tsx'
import { readTrainingRecord, type TrainingRecord } from '../../../record/training-record.ts'
import { useStrengthContext } from '../../../router-context.ts'
import { strengthKeyOf, type StrengthSession } from '../../../session/strength-session.ts'

/** What a lifter's tab is drawn over: what it writes through, and what it shows. */
interface LifterRecord {
  /** The lifter's session, which every write takes. */
  readonly session: StrengthSession
  /** The lifter's training record, as read off the server. */
  readonly trainingRecord: TrainingRecord
}

/** Where the read a {@link LifterTab} waits on stands. */
type LifterRecordRead =
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'loading' }
  | ({ readonly kind: 'read' } & LifterRecord)

/**
 * The training record (`readTrainingRecord`) of the lifter the path names,
 * with the {@link StrengthSession} their writes go through.
 */
const useLifterRecord = (): LifterRecordRead => {
  const { client, runAuthed } = useStrengthContext()
  const patientId = useParams({
    from: '/patients/$patientId',
    select: (params) => params.patientId,
  })
  const session = useMemo(
    (): StrengthSession => ({ client, patientId, runAuthed }),
    [client, patientId, runAuthed]
  )
  const trainingRecord = useQuery({
    queryKey: [...strengthKeyOf(patientId), 'training'],
    queryFn: () => Effect.runPromise(readTrainingRecord(client, patientId)),
  })

  if (trainingRecord.isError) return { kind: 'failed', error: trainingRecord.error }
  if (trainingRecord.data === undefined) return { kind: 'loading' }
  return { kind: 'read', session, trainingRecord: trainingRecord.data }
}

/** Props for {@link LifterTab}. */
interface LifterTabProps {
  /** The tab's body, over the lifter's record once it is read. */
  readonly children: (lifterRecord: LifterRecord) => JSX.Element
}

/**
 * A tab that writes (Today, Plan): the lifter's training record, what of it
 * could not be read, and `children` over it, writing through the lifter's
 * {@link StrengthSession}.
 */
const LifterTab = ({ children }: LifterTabProps): JSX.Element => {
  const lifterRecordRead = useLifterRecord()
  return Match.value(lifterRecordRead).pipe(
    Match.when({ kind: 'failed' }, ({ error }) => (
      <ReadFailureLine subject="your training" error={error} />
    )),
    Match.when({ kind: 'loading' }, () => <LoadingLine subject="your training" />),
    Match.when({ kind: 'read' }, (read) => (
      <>
        <TrainingRecordNotices trainingRecord={read.trainingRecord} />
        {children(read)}
      </>
    )),
    Match.exhaustive
  )
}

export { LifterTab, type LifterRecord, type LifterTabProps }
