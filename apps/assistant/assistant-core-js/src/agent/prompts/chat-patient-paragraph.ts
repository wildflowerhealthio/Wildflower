import { HumanName } from '@wildflowerhealthio/fhir-r4/data-types'
import type { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Match, Option } from 'effect'

import type * as ChatPatient from '../../chat-patient.ts'

/**
 * The system prompt's paragraph on whose record the chat is about.
 *
 * @remarks
 * A namespace module: `ChatPatientParagraph.of`. The name and birth date
 * are read from the chosen patient's record (`fhir-r4`'s
 * `HumanName.displayName`).
 *
 * @packageDocumentation
 */

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

/**
 * Whose record the chat is about, in words, for the system prompt: for one
 * patient, their name, birth date and FHIR id.
 */
const of = (chatPatient: ChatPatient.Type): string =>
  Match.value(chatPatient).pipe(
    Match.when(
      { kind: 'patient' },
      ({ patient }) =>
        `This chat is about one patient, ${nameAndBirthOf(patient)}. Their record is Patient/${patient.id}. Your tools keep every search, read and write to this patient's records.`
    ),
    Match.when(
      { kind: 'all-patients' },
      () =>
        'This chat is not about one patient: the person chose "All patients", every patient on the server.'
    ),
    Match.exhaustive
  )

export { of }
