import { useNavigate, useSearch } from '@tanstack/react-router'
import { Option, Schema } from 'effect'
import { useCallback, useMemo } from 'react'

import {
  PATIENT_PARAM,
  type PatientChoice,
  patientChoiceKeyOf,
  patientChoiceOfKey,
} from './patient-choice.ts'
import type { PatientChoosing } from './use-patient-choice.ts'

/**
 * Query key marking a history entry as the patient picker's: present (as
 * `1`) on the entry "Change patient" pushes, over the `?patient=` it was
 * opened from. A root keeps only `?patient=` across navigations, so no other
 * navigation carries it: Back leaves the picker, and a choice lands without
 * it.
 */
const PICKING_PATIENT_PARAM = 'picking-patient'

/**
 * The search a routed SMART app's root route validates (`validateSearch:
 * Schema.standardSchemaV1(PatientSearch)`): whose records the page reads,
 * `?patient=` (a patient's id, or `*` for every patient), absent for the
 * launch's patient, which every navigation keeps
 * (`retainSearchParams([PATIENT_PARAM])`); and the picker's
 * {@link PICKING_PATIENT_PARAM}, which none does.
 *
 * @remarks
 * Read as a string only under `parsePlainSearch`, which a router
 * carrying it is built with.
 */
const PatientSearch = Schema.Struct({
  [PATIENT_PARAM]: Schema.optional(Schema.String),
  [PICKING_PATIENT_PARAM]: Schema.optional(Schema.String),
})

/** `search[key]` when the router holds it as a string (as `PatientSearch` does), else `undefined`. */
const searchStringOf =
  (key: string) =>
  (search: Readonly<Record<string, unknown>>): string | undefined => {
    const value = search[key]
    return typeof value === 'string' ? value : undefined
  }

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
  const patientKey = useSearch({ strict: false, select: searchStringOf(PATIENT_PARAM) })
  return useMemo(
    () => routedPatientChoiceOf(patientKey, launchPatientId),
    [patientKey, launchPatientId]
  )
}

/**
 * A routed app root's patient choosing, the router's counterpart of
 * `usePatientChoice`: whose records the page shows, `None` while the picker
 * is up ({@link PICKING_PATIENT_PARAM} set, or no patient to show), with the
 * picker's `choosePatient` and the patient line's `changePatient`.
 *
 * @param launchPatientId - The launch's patient, `client.patient.id`, as
 *   {@link useRoutedPatientChoice} takes it.
 * @param choiceLandsOn - Where a choice navigates: a path of the app's (a
 *   strength app's `/`, which opens the choice's first tab), or `.` for the
 *   tab open.
 *
 * @remarks
 * Both are navigations, each pushing a history entry. "Change patient" adds
 * {@link PICKING_PATIENT_PARAM} to the location open, keeping its
 * `?patient=`, so Back closes the picker on the page it was opened over. A
 * choice lands on `choiceLandsOn` with `?patient=` naming it and no flag, so
 * a reload or a shared link opens the patient the address bar names. Read
 * and navigated without the app's route tree (`strict: false`, `to` as a
 * string), under a root that validates {@link PatientSearch}.
 */
const useRoutedPatientPicker = (
  launchPatientId: string | null | undefined,
  choiceLandsOn: string
): PatientChoosing => {
  const routedPatientChoice = useRoutedPatientChoice(launchPatientId)
  const isPicking =
    useSearch({ strict: false, select: searchStringOf(PICKING_PATIENT_PARAM) }) !== undefined
  const navigate = useNavigate()
  const choosePatient = useCallback(
    (patientChoice: PatientChoice) => {
      void navigate({
        to: choiceLandsOn,
        search: { [PATIENT_PARAM]: patientChoiceKeyOf(patientChoice) },
      })
    },
    [navigate, choiceLandsOn]
  )
  const changePatient = useCallback(() => {
    void navigate({
      to: '.',
      search: (search: Readonly<Record<string, unknown>>) => ({
        ...search,
        [PICKING_PATIENT_PARAM]: '1',
      }),
    })
  }, [navigate])
  const patientChoice = useMemo(
    () => Option.filter(routedPatientChoice, () => !isPicking),
    [routedPatientChoice, isPicking]
  )
  return { patientChoice, choosePatient, changePatient }
}

export {
  PatientSearch,
  PICKING_PATIENT_PARAM,
  routedPatientChoiceOf,
  useRoutedPatientChoice,
  useRoutedPatientPicker,
}
