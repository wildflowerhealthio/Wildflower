import type { PatientResource } from 'fhir-r4-react/smart'
import { HumanName } from 'fhir-r4/data-types'

/** What a patient without a renderable name is called. */
const UNNAMED_PATIENT = 'No name on record'

/** The name a patient is shown under: their current display name. */
const patientNameOf = (patient: PatientResource): string =>
  HumanName.displayName(patient.name) ?? UNNAMED_PATIENT

/** `born YYYY-MM-DD`, or `null` when the record carries no birth date. */
const birthLineOf = (patient: PatientResource): string | null => {
  const birthDate = patient.birthDate ?? null
  return birthDate === null ? null : `born ${birthDate}`
}

/** One line naming a patient: `Name · born YYYY-MM-DD`, or the name alone without a birth date. */
const patientLineOf = (patient: PatientResource): string => {
  const birthLine = birthLineOf(patient)
  return birthLine === null ? patientNameOf(patient) : `${patientNameOf(patient)} · ${birthLine}`
}

export { birthLineOf, patientLineOf, patientNameOf }
