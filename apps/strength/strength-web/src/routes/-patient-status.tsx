import { useNavigate } from '@tanstack/react-router'
import { type PatientChoice, PatientChoiceLine } from '@wildflowerhealthio/smart-app-react'
import type { JSX } from 'react'

import styles from './-patient-status.module.css'

/**
 * Whose record the page shows, under the app's title, with "Change patient",
 * which pushes the picker, so Back closes it.
 */
function PatientStatus({ patientChoice }: { readonly patientChoice: PatientChoice }): JSX.Element {
  const navigate = useNavigate()
  return (
    <div className={styles['patient-status']}>
      <PatientChoiceLine
        patientChoice={patientChoice}
        onPatientChange={() => {
          void navigate({ to: '/patients' })
        }}
      />
    </div>
  )
}

export { PatientStatus }
