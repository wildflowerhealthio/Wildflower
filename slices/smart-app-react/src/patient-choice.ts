import { Option } from 'effect'

/**
 * Whose records a SMART app reads, as the reader chose them in the app: one
 * patient's, or every patient's the session can see.
 */
type PatientChoice =
  | { readonly kind: 'patient'; readonly patientId: string }
  | { readonly kind: 'all-patients' }

/** Query key holding the {@link PatientChoice}. */
const PATIENT_PARAM = 'patient'

/**
 * The {@link PATIENT_PARAM} value for every patient. `*` is outside FHIR's id
 * grammar (`[A-Za-z0-9\-\.]{1,64}`), so no patient's id is ever it.
 */
const ALL_PATIENTS_PARAM_VALUE = '*'

/**
 * The patient scope a `fhir-r4-react/smart` reader takes for `patientChoice`:
 * the patient's id, or `null` for an unscoped read of every patient's.
 */
const patientScopeOf = (patientChoice: PatientChoice): string | null =>
  patientChoice.kind === 'patient' ? patientChoice.patientId : null

/**
 * The choice as one string: the patient's id, or `*` for every patient. It is
 * what `?patient=` holds, and a key a page remounts its reads under — distinct
 * per patient and from every patient.
 */
const patientChoiceKeyOf = (patientChoice: PatientChoice): string =>
  patientChoice.kind === 'patient' ? patientChoice.patientId : ALL_PATIENTS_PARAM_VALUE

/**
 * The choice {@link patientChoiceKeyOf} made `key`: `*` is every patient, any
 * other id that patient, and the empty string no choice yet. Never throws.
 */
const patientChoiceOfKey = (key: string): Option.Option<PatientChoice> => {
  if (key === '') return Option.none()
  return Option.some(
    key === ALL_PATIENTS_PARAM_VALUE
      ? { kind: 'all-patients' }
      : { kind: 'patient', patientId: key }
  )
}

/**
 * Read the choice back out of query parameters: `?patient=*` is every
 * patient, `?patient=<id>` that patient, and an absent or empty `patient` is
 * no choice yet. Never throws.
 */
const decodePatientChoice = (params: URLSearchParams): Option.Option<PatientChoice> =>
  patientChoiceOfKey(params.get(PATIENT_PARAM) ?? '')

/**
 * A copy of `params` with `patientChoice` as its `patient`, and every other
 * key kept as it was — an app's own query state shares the URL with it.
 */
const withPatientChoice = (
  params: URLSearchParams,
  patientChoice: PatientChoice
): URLSearchParams => {
  const choiceParams = new URLSearchParams(params)
  choiceParams.set(PATIENT_PARAM, patientChoiceKeyOf(patientChoice))
  return choiceParams
}

export {
  ALL_PATIENTS_PARAM_VALUE,
  decodePatientChoice,
  PATIENT_PARAM,
  type PatientChoice,
  patientChoiceKeyOf,
  patientChoiceOfKey,
  patientScopeOf,
  withPatientChoice,
}
