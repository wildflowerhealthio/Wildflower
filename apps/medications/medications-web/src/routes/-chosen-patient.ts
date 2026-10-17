import { type PatientChoice, useRoutedPatientChoice } from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'

import { useSmartClient } from '../router-context.ts'

/**
 * Whose medications the address bar names: `smart-app-react`'s
 * `useRoutedPatientChoice` over the launch's patient: the root route's
 * `?patient=`, else `client.patient.id`, else none yet, which the root shows
 * as the patient picker.
 */
const useChosenPatient = (): Option.Option<PatientChoice> =>
  useRoutedPatientChoice(useSmartClient().patient.id)

/**
 * The patient the tabs read: the chosen one. The root shows the picker in
 * place of the tabs while there is none, so a tab never renders without one.
 */
const useReadPatient = (): PatientChoice =>
  Option.getOrThrowWith(
    useChosenPatient(),
    () => new Error('A tab rendered with no patient chosen: the root shows the picker then')
  )

export { useChosenPatient, useReadPatient }
