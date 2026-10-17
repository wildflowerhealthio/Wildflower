import { useSearch } from '@tanstack/react-router'
import { Option, Schema } from 'effect'
import { useMemo } from 'react'

import { PATIENT_PARAM, type PatientChoice, patientChoiceOfKey } from './patient-choice.ts'

/**
 * The search a routed SMART app's root route validates (`validateSearch:
 * Schema.standardSchemaV1(PatientSearch)`) and every navigation keeps
 * (`retainSearchParams([PATIENT_PARAM])`): whose records the page reads,
 * `?patient=` (a patient's id, or `*` for every patient), absent for the
 * launch's patient.
 *
 * @remarks
 * Read as a string only under `parsePlainSearch`, which a router
 * carrying it is built with.
 */
const PatientSearch = Schema.Struct({ [PATIENT_PARAM]: Schema.optional(Schema.String) })

/**
 * Whose records a routed app's address bar names: `patientKey` (its
 * `?patient=`) when it carries one, else the launch's patient
 * (`launchPatientId`, `client.patient.id`, e.g. an EHR launch from a
 * patient's record), else none yet, which the app shows as the patient
 * picker. For a route's `beforeLoad`, which reads the search it is handed;
 * a component reads {@link useRoutedPatientChoice}.
 */
const routedPatientChoiceOf = (
  patientKey: string | undefined,
  launchPatientId: string | null | undefined
): Option.Option<PatientChoice> =>
  Option.orElse(patientChoiceOfKey(patientKey ?? ''), () =>
    Option.map(Option.fromNullable(launchPatientId), (patientId): PatientChoice => ({
      kind: 'patient',
      patientId,
    }))
  )

/**
 * {@link routedPatientChoiceOf} for the router's current location, under
 * any route of an app whose root validates {@link PatientSearch}.
 *
 * @remarks
 * Read from the router's location, so it is the history entry's own: Back
 * and Forward bring each entry's patient back with its tab.
 */
const useRoutedPatientChoice = (
  launchPatientId: string | null | undefined
): Option.Option<PatientChoice> => {
  // Read under whichever route is matched (`strict: false`), so the hook
  // needs no app's route tree; the root's `PatientSearch` makes it a string.
  const patientKey = useSearch({
    strict: false,
    select: (search: Readonly<Record<string, unknown>>): string | undefined => {
      const value = search[PATIENT_PARAM]
      return typeof value === 'string' ? value : undefined
    },
  })
  return useMemo(
    () => routedPatientChoiceOf(patientKey, launchPatientId),
    [patientKey, launchPatientId]
  )
}

export { PatientSearch, routedPatientChoiceOf, useRoutedPatientChoice }
