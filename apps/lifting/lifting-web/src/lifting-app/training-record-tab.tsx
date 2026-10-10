import { useQuery } from '@tanstack/react-query'
import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import { LoadingLine, ReadFailureLine } from '@wildflowerhealthio/smart-app-react'
import { Effect } from 'effect'
import { type JSX, useMemo } from 'react'

import { TrainingRecordNotices } from '../record/training-record-notices.tsx'
import { readTrainingRecord } from '../record/training-record.ts'
import { liftingKeyOf, type LiftingSession } from '../session/lifting-session.ts'
import type { SmartClient } from '../smart-client.ts'
import { type Tab, TabBody } from './tab-body.tsx'

/** Props for {@link TrainingRecordTab}. */
interface TrainingRecordTabProps {
  readonly tab: Exclude<Tab, 'history'>
  /** The SMART client every search is issued through. */
  readonly client: SmartClient
  /** The lifter whose record is read and written. */
  readonly patientId: string
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
  /** The id the StrongLifts 5×5 template is stored under if it is started. */
  readonly strongLiftsPlanDefinitionId: string
  /** Called once the plan tab has started a program. */
  readonly onStarted: () => void
}

/**
 * The Today or Plan tab for one lifter: their training record
 * (`readTrainingRecord`), what of it could not be read, and {@link TabBody}
 * over it, writing through the lifter's {@link LiftingSession}.
 */
const TrainingRecordTab = ({
  tab,
  client,
  patientId,
  runAuthed,
  strongLiftsPlanDefinitionId,
  onStarted,
}: TrainingRecordTabProps): JSX.Element => {
  const session = useMemo(
    (): LiftingSession => ({ client, patientId, runAuthed }),
    [client, patientId, runAuthed]
  )
  const trainingRecord = useQuery({
    queryKey: [...liftingKeyOf(patientId), 'training'],
    queryFn: () => Effect.runPromise(readTrainingRecord(client, patientId)),
  })

  if (trainingRecord.isError) {
    return <ReadFailureLine subject="your training" error={trainingRecord.error} />
  }
  if (trainingRecord.data === undefined) return <LoadingLine subject="your training" />
  return (
    <>
      <TrainingRecordNotices trainingRecord={trainingRecord.data} />
      <TabBody
        tab={tab}
        session={session}
        trainingRecord={trainingRecord.data}
        strongLiftsPlanDefinitionId={strongLiftsPlanDefinitionId}
        onStarted={onStarted}
      />
    </>
  )
}

export { TrainingRecordTab, type TrainingRecordTabProps }
