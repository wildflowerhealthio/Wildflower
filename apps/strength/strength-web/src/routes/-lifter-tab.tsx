import { skipToken, useQuery } from '@tanstack/react-query'
import { GateCard } from '@wildflowerhealthio/react-tundraish'
import { LoadingLine, ReadFailureLine } from '@wildflowerhealthio/smart-app-react'
import { Effect, Match } from 'effect'
import { type JSX, useMemo } from 'react'

import { TrainingRecordNotices } from '../record/training-record-notices.tsx'
import { readTrainingRecord, type TrainingRecord } from '../record/training-record.ts'
import {
  useChangePatient,
  useChosenPatient,
  useRunAuthed,
  useSmartClient,
} from '../router-context.ts'
import { strengthKeyOf, type StrengthSession } from '../session/strength-session.ts'

/** What a lifter's tab is drawn over: what it writes through, and what it shows. */
interface LifterRecord {
  /** The chosen lifter's session, which every write takes. */
  readonly session: StrengthSession
  /** The lifter's training record, as read off the server. */
  readonly trainingRecord: TrainingRecord
}

/** Where the read a {@link LifterTab} waits on stands. */
type LifterRecordRead =
  | { readonly kind: 'no-lifter' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'loading' }
  | ({ readonly kind: 'read' } & LifterRecord)

/**
 * The chosen lifter's training record (`readTrainingRecord`), with the
 * {@link StrengthSession} their writes go through; nothing is read for All
 * patients, who have no lifter.
 */
const useLifterRecord = (): LifterRecordRead => {
  const client = useSmartClient()
  const runAuthed = useRunAuthed()
  const patientChoice = useChosenPatient()
  const patientId = patientChoice.kind === 'patient' ? patientChoice.patientId : null
  const session = useMemo(
    (): StrengthSession | null => (patientId === null ? null : { client, patientId, runAuthed }),
    [client, patientId, runAuthed]
  )
  const trainingRecord = useQuery({
    queryKey: [...strengthKeyOf(patientId), 'training'],
    queryFn:
      patientId === null
        ? skipToken
        : () => Effect.runPromise(readTrainingRecord(client, patientId)),
  })

  if (session === null) return { kind: 'no-lifter' }
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
 * A tab that writes, and so is one lifter's (Today, Plan): their training
 * record, what of it could not be read, and `children` over it, writing
 * through the lifter's {@link StrengthSession}. With All patients there is no
 * lifter to write for, so the tab asks for one instead.
 */
const LifterTab = ({ children }: LifterTabProps): JSX.Element => {
  const lifterRecordRead = useLifterRecord()
  const changePatient = useChangePatient()
  return Match.value(lifterRecordRead).pipe(
    Match.when({ kind: 'no-lifter' }, () => (
      <GateCard
        title="Choose a patient to train"
        body="A workout and a program are one lifter's, so logging or changing one needs a patient. History shows every patient's workouts."
        showSpinner={false}
        action={{ label: 'Choose a patient', onClick: changePatient }}
      />
    )),
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
