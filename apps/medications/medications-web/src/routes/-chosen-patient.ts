import {
  type PatientChoice,
  type PatientChoosing,
  useRoutedPatientChoice,
  useRoutedPatientPicker,
} from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'

import { useSmartClient } from '../router-context.ts'

/**
 * The root's patient choosing: `smart-app-react`'s `useRoutedPatientPicker`
 * over the launch's patient, a choice landing on the tab open (`.`).
 */
const useMedicationsPatientPicker = (): PatientChoosing =>
  useRoutedPatientPicker(useSmartClient().patient.id, '.')

/**
 * The patient the tabs read: whose medications the address bar names, else
 * the launch's (`smart-app-react`'s `useRoutedPatientChoice`). The root
 * shows the picker in place of the tabs while there is none, so a tab never
 * renders without one.
 */
const useReadPatient = (): PatientChoice =>
  Option.getOrThrowWith(
    useRoutedPatientChoice(useSmartClient().patient.id),
    () => new Error('A tab rendered with no patient chosen: the root shows the picker then')
  )

export { useMedicationsPatientPicker, useReadPatient }
