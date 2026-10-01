import { useQuery } from '@tanstack/react-query'
import { Effect } from 'effect'
import { type JSX, useMemo, useState } from 'react'
import { SegmentedToggle } from 'react-tundraish'
import { LoadingLine, ReadFailureLine } from 'smart-app-react'

import { HistoryTab } from './history-tab.tsx'
import { readTrainingRecord } from './lifting-record.ts'
import { liftingKeyOf, type LiftingSession } from './lifting-session.ts'
import { mintResourceId } from './mint-ids.ts'
import { TrainingRecordNotices } from './record-notices.tsx'
import { type Tab, TabBody } from './tab-body.tsx'
import styles from './lifting-app.module.css'

const TAB_OPTIONS: readonly { readonly value: Tab; readonly label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'plan', label: 'Plan' },
  { value: 'history', label: 'History' },
]

/**
 * The lifting screens for one lifter: their training record read off the
 * server, under a **Today | Plan | History** toggle.
 *
 * @remarks
 * Split from {@link App} so the whole tree can be driven in a test over a
 * stub client and transport: the handshake is the only part that needs a
 * browser redirect.
 *
 * The app holds no lifting logic: reads go through `fhir-r4-react/smart`'s
 * page readers into `lifting-core`'s schemas (`readTrainingRecord`), each
 * screen is a `lifting-react` view over plain props, and each write is what
 * `lifting-core` returns, in one batch. While any write is pending every
 * screen's controls are disabled, so two writes never race.
 */
const LiftingApp = ({ client, patientId, runAuthed }: LiftingSession): JSX.Element => {
  const session = useMemo(
    (): LiftingSession => ({ client, patientId, runAuthed }),
    [client, patientId, runAuthed]
  )
  const [tab, setTab] = useState<Tab>('today')
  const [strongLiftsPlanDefinitionId] = useState(mintResourceId)
  const trainingRecord = useQuery({
    queryKey: [...liftingKeyOf(patientId), 'training'],
    queryFn: () => Effect.runPromise(readTrainingRecord(client, patientId)),
  })

  const body = ((): JSX.Element => {
    if (tab === 'history') return <HistoryTab session={session} />
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
          onStarted={() => {
            setTab('today')
          }}
        />
      </>
    )
  })()

  return (
    <>
      <header className={styles['lifting-app__header']}>
        <h1 className="text-heading-3">Lifting</h1>
        <SegmentedToggle value={tab} options={TAB_OPTIONS} onChange={setTab} aria-label="View" />
      </header>
      {body}
    </>
  )
}

export { LiftingApp }
