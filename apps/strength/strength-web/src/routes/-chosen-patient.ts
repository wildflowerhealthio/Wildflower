import {
  type PatientChoice,
  patientChoiceKeyOf,
  useRoutedPatientChoice,
} from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'

import { useStrengthContext } from '../router-context.ts'

/**
 * Whose record the address bar names: `smart-app-react`'s
 * `useRoutedPatientChoice` over the launch's patient: the root route's
 * `?patient=`, else `client.patient.id`, else none yet, which the root shows
 * as the patient picker.
 */
const useChosenPatient = (): Option.Option<PatientChoice> =>
  useRoutedPatientChoice(useStrengthContext().client.patient.id)

/**
 * The patient the tabs read: the chosen one. The root shows the picker in
 * place of the tabs while there is none, so a tab never renders without one.
 */
const useReadPatient = (): PatientChoice =>
  Option.getOrThrowWith(
    useChosenPatient(),
    () => new Error('A tab rendered with no patient chosen: the root shows the picker then')
  )

/**
 * Open the picker over the patient shown: the patient line's "Change
 * patient", and the action of a tab that needs a lifter. The address bar
 * keeps the patient until another is chosen.
 */
const useChangePatient = (): (() => void) => {
  const { patientChangingFrom } = useStrengthContext()
  const chosenKey = Option.getOrNull(Option.map(useChosenPatient(), patientChoiceKeyOf))
  return () => {
    patientChangingFrom.set(chosenKey)
  }
}

export { useChangePatient, useChosenPatient, useReadPatient }
