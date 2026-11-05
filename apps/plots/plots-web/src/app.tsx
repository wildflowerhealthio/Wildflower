import type { SmartConnection } from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  LoadingLine,
  PatientChoiceLine,
  PatientPicker,
  patientChoiceKeyOf,
  patientScopeOf,
  SmartHandshakeGate,
  usePatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { walkthroughAnchor } from '@wildflowerhealthio/walkthrough-core'
import { DateTime, Option } from 'effect'
import type { JSX } from 'react'
import { useState } from 'react'

import { PatientRecord } from './patient-record.tsx'
import { PlotsPageWalkthroughAnchor } from './plots-walkthrough.ts'
import { useUrlSelection } from './use-url-selection.ts'
import styles from './app.module.css'

/**
 * The redirect-target app: completes the SMART handshake under
 * `SmartHandshakeGate`, settles on whose record to read, and hands it to
 * {@link PatientRecord}.
 *
 * @remarks
 * Whose record is `smart-app-react`'s `usePatientChoice`: the URL's
 * `?patient=`, else the launch's patient (`connection.launchPatientId`); with neither
 * the page is the `PatientPicker`. "All patients" reads every patient's
 * Observations and MedicationRequests unscoped, charted together. The
 * `PatientChoiceLine` under the title names the choice and goes back to the picker, and
 * carries the Plots walkthrough's anchor. The title sits above the gate, so
 * it shows while the handshake connects and when it fails.
 *
 * The selection lives only in the URL ({@link useUrlSelection}) beside the
 * patient; every change — a series or a range in the record — is an updater
 * over the latest selection, so changes made in one tick compose.
 */
export const App = (): JSX.Element => (
  <main className={styles.app}>
    <header className={styles.header}>
      <h1 className="text-heading-3">Plots</h1>
    </header>
    <SmartHandshakeGate connecting={<LoadingLine />}>
      {({ connection }) => <PlotsPage connection={connection} />}
    </SmartHandshakeGate>
  </main>
)

/**
 * The page over a completed handshake's `connection`: the line naming whose
 * record it reads, under the title, then the picker or the chosen record,
 * each read over the handshake's runtime (`useRunSmart`).
 */
const PlotsPage = ({ connection }: { readonly connection: SmartConnection }): JSX.Element => {
  const { selection, updateSelection } = useUrlSelection()
  // The instant the page opened: the right edge of every bounded range, held
  // still so the chart's window does not move on each render.
  const [openedAt] = useState(() => DateTime.unsafeNow())
  const { patientChoice, choosePatient, changePatient } = usePatientChoice(
    connection.launchPatientId
  )

  return (
    <>
      {patientChoice.pipe(
        Option.map((chosen) => (
          <PatientChoiceLine
            key="patient-line"
            className={styles['patient-line']}
            patientChoice={chosen}
            onPatientChange={changePatient}
            {...walkthroughAnchor(PlotsPageWalkthroughAnchor.patientLine)}
          />
        )),
        Option.getOrNull
      )}
      {patientChoice.pipe(
        Option.map((chosen) => (
          <PatientRecord
            // Remounted per choice, so no read or reconciliation carries over.
            key={patientChoiceKeyOf(chosen)}
            patientId={patientScopeOf(chosen)}
            selection={selection}
            onSelectionUpdate={updateSelection}
            openedAt={openedAt}
          />
        )),
        Option.getOrElse(() => (
          <PatientPicker key="patient-picker" onPatientChoice={choosePatient} />
        ))
      )}
    </>
  )
}
