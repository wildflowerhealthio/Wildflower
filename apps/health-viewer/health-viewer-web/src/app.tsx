import { DateTime, Match, Option } from 'effect'
import { useLaunchFailureRedirect, useSmartHandshake } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { useState } from 'react'
import { ErrorBanner } from 'react-tundraish'
import {
  LoadingLine,
  PatientChoiceLine,
  PatientPicker,
  patientChoiceKeyOf,
  patientScopeOf,
  usePatientChoice,
} from 'smart-app-react'

import { PatientRecord } from './patient-record.tsx'
import { useUrlSelection } from './use-url-selection.ts'
import styles from './app.module.css'

/**
 * The redirect-target app: completes the SMART handshake, settles on whose
 * record to read, and hands it to {@link PatientRecord}.
 *
 * @remarks
 * Whose record is `smart-app-react`'s `usePatientChoice`: the URL's
 * `?patient=`, else the launch's patient (`client.patient.id`); with neither
 * the page is the `PatientPicker`. "All patients" reads every patient's
 * Observations and MedicationRequests unscoped, charted together. The title's
 * `PatientChoiceLine` names the choice and goes back to the picker.
 *
 * The selection lives only in the URL ({@link useUrlSelection}) beside the
 * patient; every change — a series or a range in the record — is an updater
 * over the latest selection, so changes made in one tick compose.
 */
export const App = (): JSX.Element => {
  const handshake = useSmartHandshake()
  // A failed exchange has nothing to retry here (the code is single-use), so
  // carry the reason to the app root, which can offer the connect menu.
  useLaunchFailureRedirect(handshake)
  const { selection, updateSelection } = useUrlSelection()
  // The instant the page opened: the right edge of every bounded range, held
  // still so the chart's window does not move on each render.
  const [openedAt] = useState(() => DateTime.unsafeNow())

  const client = handshake.kind === 'ready' ? handshake.client : undefined
  const { patientChoice, choosePatient, changePatient } = usePatientChoice(
    client?.patient.id ?? null
  )

  const body = Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => <LoadingLine />),
    Match.when({ kind: 'ready' }, ({ client: readyClient }) =>
      Option.isNone(patientChoice) ? (
        <PatientPicker client={readyClient} onPatientChoice={choosePatient} />
      ) : (
        <PatientRecord
          // Remounted per choice, so no read or reconciliation carries over.
          key={patientChoiceKeyOf(patientChoice.value)}
          client={readyClient}
          patientId={patientScopeOf(patientChoice.value)}
          selection={selection}
          onSelectionUpdate={updateSelection}
          openedAt={openedAt}
        />
      )
    ),
    Match.exhaustive
  )

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <h1 className="text-heading-3">Synthesized Health Viewer</h1>
        {client !== undefined && Option.isSome(patientChoice) && (
          <PatientChoiceLine
            client={client}
            patientChoice={patientChoice.value}
            onPatientChange={changePatient}
          />
        )}
      </header>
      {body}
    </main>
  )
}
