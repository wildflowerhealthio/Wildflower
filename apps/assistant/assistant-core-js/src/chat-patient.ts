import type { WithMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import type { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Match, Option } from 'effect'

/**
 * Whose record a chat is about, as the app chose it: one patient, as the
 * server's `Patient` record has them, or every patient the session can see.
 *
 * @remarks
 * A namespace module: `ChatPatient.Type`, `ChatPatient.keyOf`,
 * `ChatPatient.patientIdIfOne`. The kinds are
 * `smart-app-react`'s `PatientChoice`'s once the chosen patient's record has
 * been read: the chat carries the FHIR `Patient` and reads its name and
 * birth date from it.
 *
 * @packageDocumentation
 */

/** One patient's `Patient` record, or every patient. */
type Type =
  | { readonly kind: 'patient'; readonly patient: WithMandatoryId<Patient.Type> }
  | { readonly kind: 'all-patients' }

/**
 * The key for every patient, as `?patient=` writes it: outside FHIR's id
 * grammar, so no patient's id is ever it.
 */
const ALL_PATIENTS_KEY = '*'

/** The chat's patient as one string: their id, or `*` for every patient. */
const keyOf = (chatPatient: Type): string =>
  Match.value(chatPatient).pipe(
    Match.when({ kind: 'patient' }, ({ patient }) => patient.id),
    Match.when({ kind: 'all-patients' }, () => ALL_PATIENTS_KEY),
    Match.exhaustive
  )

/** The id of the patient the chat's reads are kept to; `None` when it is about every patient. */
const patientIdIfOne = (chatPatient: Type): Option.Option<string> =>
  Match.value(chatPatient).pipe(
    Match.when({ kind: 'patient' }, ({ patient }) => Option.some(patient.id)),
    Match.when({ kind: 'all-patients' }, () => Option.none()),
    Match.exhaustive
  )

export { keyOf, patientIdIfOne }
export type { Type }
