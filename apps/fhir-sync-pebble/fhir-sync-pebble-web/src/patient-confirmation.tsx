import { HumanName } from 'fhir-r4/data-types'
import { PebbleSettings } from 'fhir-sync-pebble-core'
import { ReturnTarget } from 'pebble-configuration'
import { useState, type JSX } from 'react'
import { ErrorBanner, PageLoading } from 'react-tundraish'
import { PatientPillPicker, type PatientOption } from 'scopes-react'

import { PatientDetails } from './patient-details.tsx'
import { usePatientSummariesQuery } from './patient-summaries-query.ts'
import styles from './patient-confirmation.module.css'

/** Props for {@link PatientConfirmation}. */
interface PatientConfirmationProps {
  /** The token and server the SMART grant carried. */
  readonly connection: PebbleSettings.Connection
  /** Where the save hands the settings back to. */
  readonly returnTarget: ReturnTarget.Type
  /** Leaves the page for the hand-off URL. */
  readonly navigate: (url: string) => void
}

/**
 * Lists the server's patients for the user to pick the one the watch will sync
 * to, shows the picked one, and owns the save that hands the settings to the
 * Pebble phone app.
 *
 * @remarks
 * The patient is picked here, not by the server's consent step: the grant is
 * `system/`-scoped and carries no patient, so picking another patient is a
 * click on this page rather than another sign-in. The picker is the consent
 * screen's own `PatientPillPicker`, each patient named by `fhir-r4`'s
 * `HumanName.displayName`, else by id.
 *
 * Every state of the list is shown: loading, a failed read (which also means
 * the token the watch would be given does not work), and a server with no
 * patients. Saving waits on a pick — until then the user has not said who the
 * watch records for — and sends the picked patient's id, name and birth date
 * with the connection, for the watch to show on-device.
 *
 * The search goes through the route context's authed runner
 * ({@link usePatientSummariesQuery}), so it is addressed to the FHIR server
 * the handshake named and carries the granted token.
 */
const PatientConfirmation = ({
  connection,
  returnTarget,
  navigate,
}: PatientConfirmationProps): JSX.Element => {
  const patients = usePatientSummariesQuery()
  const [pickedPatientId, setPickedPatientId] = useState<string | null>(null)

  const listedPatients = patients.data ?? []
  const pickedPatient = listedPatients.find((patient) => patient.id === pickedPatientId)
  const patientOptions: readonly PatientOption[] = listedPatients.map((patient) => ({
    id: patient.id,
    displayName: HumanName.displayName(patient.name) ?? patient.id,
  }))

  return (
    <section className={styles['confirmation']} aria-label="Patient">
      {patients.isPending && <PageLoading message="Reading the server's patients…" />}
      <ErrorBanner error={patients.error} />
      {patients.isSuccess && patientOptions.length === 0 && (
        <p className="text-body-3">
          This server has no patients to choose from, so there is no one for the watch to sync to.
        </p>
      )}
      {patientOptions.length > 0 && (
        <PatientPillPicker
          patients={patientOptions}
          value={pickedPatientId}
          onChange={setPickedPatientId}
        />
      )}
      {pickedPatient !== undefined && (
        <PatientDetails patient={pickedPatient} connection={connection} />
      )}
      <div className={styles['actions']}>
        <button
          type="button"
          className="button-2"
          disabled={pickedPatient === undefined}
          onClick={(): void => {
            if (pickedPatient === undefined) return
            navigate(
              ReturnTarget.handoffUrl(
                returnTarget,
                PebbleSettings.toJson(PebbleSettings.withPatient(connection, pickedPatient))
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
