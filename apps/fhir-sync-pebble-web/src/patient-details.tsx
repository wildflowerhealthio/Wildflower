import type { PatientResource } from 'fhir-r4-react'
import { HumanName } from 'fhir-r4/data-types'
import type { JSX } from 'react'

import type * as PebbleSettings from './pebble-settings.ts'
import styles from './patient-details.module.css'

/** Props for {@link PatientDetails}. */
interface PatientDetailsProps {
  /** The patient the server put in context, as the server returned it. */
  readonly patient: PatientResource
  /** The connection the watch will receive — the id and server shown beside the name. */
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
    <dd className={styles['machine']}>{connection.patientId}</dd>
    <dt className="text-label-2">FHIR server</dt>
    <dd className={styles['machine']}>{connection.fhirBaseUrl}</dd>
  </dl>
)

export { PatientDetails, type PatientDetailsProps }
