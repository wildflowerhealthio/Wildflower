import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { type PatientChoice, PatientPicker } from '@wildflowerhealthio/smart-app-react'
import { Match } from 'effect'
import type { JSX } from 'react'

/**
 * The patient picker: a patient opens their page (Today), All patients
 * every patient's workouts. Each choice is a new history entry, so Back
 * returns to the picker.
 */
function StrengthPatientPicker(): JSX.Element {
  const navigate = useNavigate()
  const choosePatient = (patientChoice: PatientChoice): void => {
    void Match.value(patientChoice).pipe(
      Match.when({ kind: 'patient' }, ({ patientId }) =>
        navigate({ to: '/patients/$patientId', params: { patientId } })
      ),
      Match.when({ kind: 'all-patients' }, () => navigate({ to: '/workouts' })),
      Match.exhaustive
    )
  }
  return <PatientPicker onPatientChoice={choosePatient} />
}

/** `/patients`, the patient picker, which "Change patient" pushes. */
const Route = createFileRoute('/patients/')({
  component: StrengthPatientPicker,
})

export { Route }
