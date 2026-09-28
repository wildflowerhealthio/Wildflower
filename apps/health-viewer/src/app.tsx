import { useQuery } from '@tanstack/react-query'
import { DateTime, Effect, Match, Option } from 'effect'
import { fetchPatient, useLaunchFailureRedirect, useSmartHandshake } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { ErrorBanner } from 'react-tundraish'
import { LoadingLine, ReadFailureLine } from 'smart-app-react'

import { patientLineOf } from './patient-line.ts'
import { PatientPicker } from './patient-picker.tsx'
import { PatientRecord } from './patient-record.tsx'
import type { SmartClient } from './smart-client.ts'
import { useUrlSelection } from './use-url-selection.ts'
import styles from './app.module.css'

/** The patient's name and birth date under the page title, from one `Patient` read. */
const PatientLine = ({
  client,
  patientId,
}: {
  readonly client: SmartClient
  readonly patientId: string
}): JSX.Element | null => {
  const patient = useQuery({
    queryKey: ['patient', patientId],
    queryFn: () => Effect.runPromise(fetchPatient(client, patientId)),
  })
  if (patient.isError) return <ReadFailureLine subject="the patient" error={patient.error} />
  if (patient.data === undefined) return null
  if (Option.isNone(patient.data)) {
    return <ReadFailureLine subject={`patient ${patientId}`} error="not a FHIR Patient" />
  }
  return <p className={styles.patient}>{patientLineOf(patient.data.value)}</p>
}

/**
 * The redirect-target app: completes the SMART handshake, settles on a
 * patient, and hands their record to {@link PatientRecord}.
 *
 * @remarks
 * The patient is the launch's (`client.patient.id`) or, with none in
 * context, the URL's `?patient=`; with neither the page is a patient picker,
 * and picking one sets `?patient=`.
 *
 * The selection lives only in the URL ({@link useUrlSelection}); every change
 * — a pick here, a series or a range in the record — is an updater over the
 * latest selection, so changes made in one tick compose.
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
  const patientId = client?.patient.id ?? selection.patient

  const pickPatient = useCallback(
    (pickedPatientId: string) => {
      updateSelection((latestSelection) => ({ ...latestSelection, patient: pickedPatientId }))
    },
    [updateSelection]
  )

  const body = Match.value(handshake).pipe(
    Match.when({ kind: 'error' }, ({ error }) => <ErrorBanner error={error} />),
    Match.when({ kind: 'connecting' }, () => <LoadingLine />),
    Match.when({ kind: 'ready' }, ({ client: readyClient }) =>
      patientId === null ? (
        <PatientPicker client={readyClient} onPatientPick={pickPatient} />
      ) : (
        <PatientRecord
          key={patientId}
          client={readyClient}
          patientId={patientId}
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
        {client !== undefined && patientId !== null && (
          <PatientLine client={client} patientId={patientId} />
        )}
      </header>
      {body}
    </main>
  )
}
