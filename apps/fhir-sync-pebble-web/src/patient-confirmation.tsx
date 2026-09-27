import { usePatientQuery } from 'fhir-r4-react'
import type { JSX } from 'react'
import { ErrorBanner, PageLoading } from 'react-tundraish'

import { PatientDetails } from './patient-details.tsx'
import * as PebbleSettings from './pebble-settings.ts'
import * as ReturnTarget from './return-target.ts'
import styles from './patient-confirmation.module.css'

/** Props for {@link PatientConfirmation}. */
interface PatientConfirmationProps {
  /** The patient, token and server the SMART grant carried. */
  readonly connection: PebbleSettings.Connection
  /** Where the save hands the settings back to. */
  readonly returnTarget: ReturnTarget.Type
  /** Leaves the page for the hand-off URL. */
  readonly navigate: (url: string) => void
}

/**
 * Reads back the patient the server's consent step picked and shows who the
 * watch will sync to, with the save that hands the settings to the Pebble phone
 * app.
 *
 * @remarks
 * Saving waits on the read: until the server has answered for the patient, the
 * user has not seen who they are connecting the watch to. A read that fails
 * blocks the save too — the token that just failed to read the patient is the
 * one the watch would be given. The save also needs the read for what it sends:
 * the watch gets the patient's name and birth date with the connection, to show
 * for confirmation on-device.
 *
 * The read goes through the route context's authed runner (`usePatientQuery`),
 * so it is addressed to the FHIR server the handshake named and carries the
 * granted token.
 */
const PatientConfirmation = ({
  connection,
  returnTarget,
  navigate,
}: PatientConfirmationProps): JSX.Element => {
  const patient = usePatientQuery(connection.patientId)

  return (
    <section className={styles['confirmation']} aria-label="Patient">
      {patient.isPending && <PageLoading message="Reading the patient…" />}
      <ErrorBanner error={patient.error} />
      {patient.isSuccess && <PatientDetails patient={patient.data} connection={connection} />}
      <div className={styles['actions']}>
        <button
          type="button"
          className="button-2"
          disabled={!patient.isSuccess}
          onClick={(): void => {
            if (!patient.isSuccess) return
            navigate(
              ReturnTarget.handoffUrl(
                returnTarget,
                PebbleSettings.withPatient(connection, patient.data)
              )
            )
          }}
        >
          Save to watch
        </button>
      </div>
    </section>
  )
}

export { PatientConfirmation, type PatientConfirmationProps }
