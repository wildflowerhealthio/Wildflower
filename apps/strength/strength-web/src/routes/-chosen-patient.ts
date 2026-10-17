import {
  type PatientChoice,
  type PatientChoosing,
  useRoutedPatientChoice,
  useRoutedPatientPicker,
} from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'

import { useStrengthContext } from '../router-context.ts'

/**
 * The root's patient choosing: `smart-app-react`'s `useRoutedPatientPicker`
 * over the launch's patient, a choice landing on `/`, which opens the
 * choice's first tab. Its `changePatient` opens the picker: the patient
 * line's "Change patient", and the action of a tab that needs a lifter.
 */
const useStrengthPatientPicker = (): PatientChoosing =>
  useRoutedPatientPicker(useStrengthContext().client.patient.id, '/')

/**
 * The patient the tabs read: whose record the address bar names, else the
 * launch's (`smart-app-react`'s `useRoutedPatientChoice`). The root shows
 * the picker in place of the tabs while there is none, so a tab never
 * renders without one.
 */
const useReadPatient = (): PatientChoice =>
  Option.getOrThrowWith(
    useRoutedPatientChoice(useStrengthContext().client.patient.id),
    () => new Error('A tab rendered with no patient chosen: the root shows the picker then')
  )

export { useReadPatient, useStrengthPatientPicker }
