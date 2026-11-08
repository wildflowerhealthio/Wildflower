import { HumanName, type WithMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import type { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Match, Option } from 'effect'

/**
 * Whose record a chat is about, as the app chose it: one patient, as the
 * server's `Patient` record has them, or every patient the session can see.
 *
 * @remarks
 * A namespace module: `ChatPatient.Type`, `ChatPatient.keyOf`,
 * `ChatPatient.patientIdIfOne`, `ChatPatient.paragraphOf`. The kinds are
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

/** `patient` in words: their display name and birth date, or that the record gives none. */
const nameAndBirthOf = (patient: Patient.Type): string => {
  const named = Option.fromNullable(HumanName.displayName(patient.name)).pipe(
    Option.getOrElse(() => 'whose record gives no name')
  )
  const born = Option.fromNullable(patient.birthDate).pipe(
    Option.match({
      onSome: (birthDate) => `born ${birthDate}`,
      onNone: () => 'whose record gives no birth date',
    })
  )
  return `${named}, ${born}`
}

/** Whose record the chat is about, in words, for the system prompt. */
const paragraphOf = (chatPatient: Type): string =>
  Match.value(chatPatient).pipe(
    Match.when(
      { kind: 'patient' },
      ({ patient }) =>
        `This chat is about one patient, ${nameAndBirthOf(patient)}. Your tools keep every search, read and write to this patient's records.`
    ),
    Match.when(
      { kind: 'all-patients' },
      () =>
        'This chat is not about one patient: the person chose "All patients", every patient on the server.'
    ),
    Match.exhaustive
  )

export { keyOf, paragraphOf, patientIdIfOne }
export type { Type }
