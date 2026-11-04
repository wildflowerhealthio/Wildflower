import type { SmartClient } from '@wildflowerhealthio/fhir-r4-react/smart'
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

import { smartRegistration } from './config.ts'
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
 * `?patient=`, else the launch's patient (`client.launchPatientId`); with neither
 * the page is the `PatientPicker`. "All patients" reads every patient's
 * Observations and MedicationRequests unscoped, charted together. The title's
 * `PatientChoiceLine` names the choice and goes back to the picker, and
 * carries the Plots walkthrough's anchor.
 *
 * The selection lives only in the URL ({@link useUrlSelection}) beside the
 * patient; every change — a series or a range in the record — is an updater
 * over the latest selection, so changes made in one tick compose.
 */
export const App = (): JSX.Element => (
  <main className={styles.app}>
    <SmartHandshakeGate
      registration={smartRegistration}
      connecting={
        <>
          <PlotsHeader />
          <LoadingLine />
        </>
      }
    >
      {(client) => <PlotsPage client={client} />}
    </SmartHandshakeGate>
  </main>
)

/** The page's title, and the line naming whose record it reads once there is one. */
const PlotsHeader = ({ children }: { readonly children?: JSX.Element }): JSX.Element => (
  <header className={styles.header}>
    <h1 className="text-heading-3">Plots</h1>
    {children}
  </header>
)

/** The page over a completed handshake's `client`: the picker, or the chosen record. */
const PlotsPage = ({ client }: { readonly client: SmartClient }): JSX.Element => {
  const { selection, updateSelection } = useUrlSelection()
  // The instant the page opened: the right edge of every bounded range, held
  // still so the chart's window does not move on each render.
  const [openedAt] = useState(() => DateTime.unsafeNow())
  const { patientChoice, choosePatient, changePatient } = usePatientChoice(client.launchPatientId)

  return (
    <>
      <PlotsHeader>
        {Option.isSome(patientChoice) ? (
          <PatientChoiceLine
            client={client}
            patientChoice={patientChoice.value}
            onPatientChange={changePatient}
            {...walkthroughAnchor(PlotsPageWalkthroughAnchor.patientLine)}
          />
        ) : undefined}
      </PlotsHeader>
      {Option.isNone(patientChoice) ? (
        <PatientPicker client={client} onPatientChoice={choosePatient} />
      ) : (
        <PatientRecord
          // Remounted per choice, so no read or reconciliation carries over.
          key={patientChoiceKeyOf(patientChoice.value)}
          client={client}
          patientId={patientScopeOf(patientChoice.value)}
          selection={selection}
          onSelectionUpdate={updateSelection}
          openedAt={openedAt}
        />
      )}
    </>
  )
}
