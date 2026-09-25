import { Array as Arr, Option, pipe, String as Str } from 'effect'
import type { MedicationRequest } from 'fhir-r4/resources'

/** The free text a person wrote on a request: the dosage sig, notes, and the prescriber's name. */

/** An entry's `text`, when it carries non-blank text. */
const nonEmptyTextOf = (entry: { readonly text: string | null }): Option.Option<string> =>
  pipe(Option.fromNullable(entry.text), Option.filter(Str.isNonEmpty))

/** Newline-join the non-empty `text` of every entry; `null` when none carry text. */
const joinTexts = (entries: readonly { readonly text: string | null }[]): string | null => {
  const texts = Arr.filterMap(entries, nonEmptyTextOf)
  return texts.length > 0 ? texts.join('\n') : null
}

/**
 * The free-text dosage sig, newline-joining every `dosageInstruction.text`
 * (e.g. Shoppers Drug Mart's per-prescription "direction"); `null` when none
 * carry text.
 */
const dosageTextOf = (request: MedicationRequest.Type): string | null =>
  joinTexts(request.dosageInstruction)

/** All `MedicationRequest.note` texts, newline-joined; `null` when there are none. */
const noteOf = (request: MedicationRequest.Type): string | null => joinTexts(request.note)

/** The prescriber's display name, from `MedicationRequest.requester`. */
const requesterOf = (request: MedicationRequest.Type): string | null =>
  pipe(
    Option.fromNullable(request.requester?.display),
    Option.filter(Str.isNonEmpty),
    Option.getOrNull
  )

export { dosageTextOf, noteOf, requesterOf }
