import { HumanName } from '@wildflowerhealthio/fhir-r4/data-types'
import type { PatientSummary, PebbleSettings } from '@wildflowerhealthio/fhir-sync-pebble-core'
import type { JSX } from 'react'

import styles from './patient-details.module.css'

/** Props for {@link PatientDetails}. */
interface PatientDetailsProps {
  /** The patient the user picked, as the server returned it. */
  readonly patient: PatientSummary.Type
  /** The connection the watch will receive — the server shown beside the patient. */
  readonly connection: PebbleSettings.Connection
}

/** Who the watch will sync to, and on which server: name, birth date, id and FHIR base. */
const PatientDetails = ({ patient, connection }: PatientDetailsProps): JSX.Element => (
  <dl className={styles['details']}>
    <dt className="text-label-2">Name</dt>
    <dd>{HumanName.displayName(patient.name) ?? 'No name on record'}</dd>
    {patient.birthDate !== null && (
      <>
        <dt className="text-label-2">Birth date</dt>
        <dd>{patient.birthDate}</dd>
      </>
    )}
    <dt className="text-label-2">Patient id</dt>
    <dd className={styles['machine']}>{patient.id}</dd>
    <dt className="text-label-2">FHIR server</dt>
    <dd className={styles['machine']}>{connection.fhirBaseUrl}</dd>
  </dl>
)

export { PatientDetails, type PatientDetailsProps }
