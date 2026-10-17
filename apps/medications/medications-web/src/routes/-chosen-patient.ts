import { useSearch } from '@tanstack/react-router'
import {
  PATIENT_PARAM,
  type PatientChoice,
  patientChoiceOfKey,
} from '@wildflowerhealthio/smart-app-react'
import { Option } from 'effect'
import { useMemo } from 'react'

import { useSmartClient } from '../router-context.ts'

/**
 * Whose medications the address bar names: the root route's `?patient=`
 * when it carries one, else the launch's patient (`client.patient.id`, e.g.
 * an EHR launch from a patient's record), else none yet, which the root
 * shows as the patient picker.
 *
 * @remarks
 * Read from the router's location, so it is the history entry's own: Back
 * and Forward bring each entry's patient back with its tab.
 */
const useChosenPatient = (): Option.Option<PatientChoice> => {
  const patientKey = useSearch({ from: '__root__', select: (search) => search[PATIENT_PARAM] })
  const launchPatientId = useSmartClient().patient.id
  return useMemo(
    () =>
      Option.orElse(patientChoiceOfKey(patientKey ?? ''), () =>
        Option.map(Option.fromNullable(launchPatientId), (patientId): PatientChoice => ({
          kind: 'patient',
          patientId,
        }))
      ),
    [patientKey, launchPatientId]
  )
}

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
