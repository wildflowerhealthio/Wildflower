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
 * Read the choice back out of query parameters: `?patient=*` is every
 * patient, `?patient=<id>` that patient, and an absent or empty `patient` is
 * no choice yet. Never throws.
 */
const decodePatientChoice = (params: URLSearchParams): Option.Option<PatientChoice> => {
  const patientParam = params.get(PATIENT_PARAM)
  if (patientParam === null || patientParam === '') return Option.none()
  return Option.some(
    patientParam === ALL_PATIENTS_PARAM_VALUE
      ? { kind: 'all-patients' }
      : { kind: 'patient', patientId: patientParam }
  )
}

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
  patientScopeOf,
  withPatientChoice,
}
