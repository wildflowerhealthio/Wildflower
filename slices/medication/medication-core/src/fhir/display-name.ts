import { Option, pipe, String as Str } from 'effect'
import { CodeableConcept } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'

import {
  containedMedicationOf,
  medicationConceptOf,
  medicationReferenceOf,
} from './medication-slots.ts'

/** A concept's label (see `CodeableConcept.label`), when there is a concept and it has one. */
const conceptName = (concept: typeof CodeableConcept.Schema.Type | null): Option.Option<string> =>
  Option.flatMap(Option.fromNullable(concept), CodeableConcept.label)

/**
 * Best human-readable name for the medication: the `medicationCodeableConcept`
 * text or first coding display, then the `medicationReference` display, then
 * the contained Medication's `code`. Falls back to `"Unknown medication"` so a
 * row always renders.
 */
const displayNameOf = (request: MedicationRequest.Type): string =>
  pipe(
    Option.firstSomeOf([
      conceptName(medicationConceptOf(request)),
      pipe(
        Option.fromNullable(medicationReferenceOf(request)?.display),
        Option.filter(Str.isNonEmpty)
      ),
      conceptName(containedMedicationOf(request)?.code ?? null),
    ]),
    Option.getOrElse(() => 'Unknown medication')
  )

export { displayNameOf }
