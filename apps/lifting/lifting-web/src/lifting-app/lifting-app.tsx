import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import { GateCard, SegmentedToggle } from '@wildflowerhealthio/react-tundraish'
import { type PatientChoice, PatientChoiceLine } from '@wildflowerhealthio/smart-app-react'
import { Match } from 'effect'
import { type JSX, useState } from 'react'

import { HistoryTab } from '../history/history-tab.tsx'
import { mintResourceId } from '../ids/mint-resource-id.ts'
import type { SmartClient } from '../smart-client.ts'
import type { Tab } from './tab-body.tsx'
import { TrainingRecordTab } from './training-record-tab.tsx'
import styles from './lifting-app.module.css'

const TAB_OPTIONS: readonly { readonly value: Tab; readonly label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'plan', label: 'Plan' },
  { value: 'history', label: 'History' },
]

/** Props for {@link LiftingApp}. */
interface LiftingAppProps {
  /** The SMART client every search is issued through. */
  readonly client: SmartClient
  /** Runs a write against the FHIR server the handshake named, with the granted token. */
  readonly runAuthed: RunAuthed
  /** Whose record the screens show: one lifter's, or every patient's, read-only. */
  readonly patientChoice: PatientChoice
  /** Called when the reader asks to choose another patient. */
  readonly onPatientChange: () => void
}

/**
 * The lifting screens for the patient chosen: their training record read off
 * the server, under a **Today | Plan | History** toggle, with whose record it
 * is named under the title.
 *
 * @remarks
 * Split from {@link App} so the whole tree can be driven in a test over a
 * stub client and transport: the handshake is the only part that needs a
 * browser redirect.
 *
 * The app holds no lifting logic: reads go through `fhir-r4-react/smart`'s
 * page readers into `lifting-core-js`'s schemas (`readTrainingRecord`), each
 * screen is a `lifting-react` view over plain props, and each write is what
 * `lifting-core-js` returns, in one batch. While any write is pending every
 * screen's controls are disabled, so two writes never race.
 *
 * Every write names one lifter, so only a chosen patient has a
 * `LiftingSession` (in {@link TrainingRecordTab}). With "All patients" the page opens on History,
 * every patient's workouts read unscoped; Today and Plan, which write, ask
 * for a patient instead.
 */
const LiftingApp = ({
  client,
  runAuthed,
  patientChoice,
  onPatientChange,
}: LiftingAppProps): JSX.Element => {
  const [tab, setTab] = useState<Tab>(patientChoice.kind === 'patient' ? 'today' : 'history')
  const [strongLiftsPlanDefinitionId] = useState(mintResourceId)

  const body = ((): JSX.Element => {
    if (tab === 'history') return <HistoryTab client={client} patientChoice={patientChoice} />
    return Match.value(patientChoice).pipe(
      Match.when({ kind: 'patient' }, ({ patientId }) => (
        <TrainingRecordTab
          tab={tab}
          client={client}
          patientId={patientId}
          runAuthed={runAuthed}
          strongLiftsPlanDefinitionId={strongLiftsPlanDefinitionId}
          onStarted={() => {
            setTab('today')
          }}
        />
      )),
      Match.when({ kind: 'all-patients' }, () => (
        <GateCard
          title="Choose a patient to train"
          body="A workout and a program are one lifter's, so logging or changing one needs a patient. History shows every patient's workouts."
          showSpinner={false}
          action={{ label: 'Choose a patient', onClick: onPatientChange }}
        />
      )),
      Match.exhaustive
    )
  })()

  return (
    <>
      <header className={styles['lifting-app__header']}>
        <h1 className="text-heading-3">Lifting</h1>
        <PatientChoiceLine
          client={client}
          patientChoice={patientChoice}
          onPatientChange={onPatientChange}
        />
        <SegmentedToggle value={tab} options={TAB_OPTIONS} onChange={setTab} aria-label="View" />
      </header>
      {body}
    </>
  )
}

export { LiftingApp, type LiftingAppProps }
