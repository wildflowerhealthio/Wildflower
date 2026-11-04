import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { type PatientChoice, PatientPicker } from '@wildflowerhealthio/smart-app-react'
import { Match } from 'effect'
import type { JSX } from 'react'

/**
 * The patient picker: a patient opens their medications, All patients every
 * patient's. Each choice is a new history entry, so Back returns to the
 * picker.
 */
function MedicationsPatientPicker(): JSX.Element {
  const navigate = useNavigate()
  const choosePatient = (patientChoice: PatientChoice): void => {
    void Match.value(patientChoice).pipe(
      Match.when({ kind: 'patient' }, ({ patientId }) =>
        navigate({ to: '/patients/$patientId', params: { patientId } })
      ),
      Match.when({ kind: 'all-patients' }, () => navigate({ to: '/medications' })),
      Match.exhaustive
    )
  }
  return <PatientPicker onPatientChoice={choosePatient} />
}

/** `/patients`, the patient picker, which "Change patient" pushes. */
const Route = createFileRoute('/patients/')({
  component: MedicationsPatientPicker,
})

export { Route }
