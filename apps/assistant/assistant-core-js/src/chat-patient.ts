import type { Option } from 'effect'

/**
 * Whose record a chat is about, as the app chose it: one patient, named, or
 * every patient the session can see.
 *
 * @remarks
 * A namespace module: `ChatPatient.Type`, `ChatPatient.keyOf`. The kinds are
 * `smart-app-react`'s `PatientChoice`'s, with the patient's name and birth
 * date added for the system prompt.
 *
 * @packageDocumentation
 */

/** One patient, with the name and birth date the prompt gives, or every patient. */
type Type =
  | {
      readonly kind: 'patient'
      /** The `Patient` resource's id. */
      readonly patientId: string
      /** The name the app shows for the patient. */
      readonly name: string
      /** The record's `birthDate` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`); `None` when it has none. */
      readonly birthDate: Option.Option<string>
    }
  | { readonly kind: 'all-patients' }

/**
 * The patient as one string: their id, or `*` for every patient, as
 * `?patient=` writes it. `*` is outside FHIR's id grammar, so no patient's
 * id is ever it.
 */
const keyOf = (patient: Type): string => (patient.kind === 'patient' ? patient.patientId : '*')

export { keyOf }
export type { Type }
