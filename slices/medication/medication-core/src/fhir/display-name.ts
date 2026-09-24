import { Array as Arr, Option, pipe } from 'effect'
import type { CodeableConcept, Coding } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

import {
  containedMedicationOf,
  medicationConceptOf,
  medicationReferenceOf,
} from './medication-slots.ts'

/** A coding's `display`, when it carries a non-blank one. */
const nonEmptyDisplayOf = (coding: Coding.Type): Option.Option<string> =>
  Option.fromNullable(nonEmpty(coding.display))

/** A concept's `text`, else its first coding `display`; `null` when neither is present. */
const conceptName = (concept: typeof CodeableConcept.Schema.Type | null): string | null =>
  concept === null
    ? null
    : (nonEmpty(concept.text) ??
      pipe(Arr.findFirst(concept.coding, nonEmptyDisplayOf), Option.getOrNull))

/**
 * Best human-readable name for the medication: the `medicationCodeableConcept`
 * text or first coding display, then the `medicationReference` display, then
 * the contained Medication's `code`. Falls back to `"Unknown medication"` so a
 * row always renders.
 */
const displayNameOf = (request: MedicationRequest.Type): string =>
  conceptName(medicationConceptOf(request)) ??
  nonEmpty(medicationReferenceOf(request)?.display) ??
  conceptName(containedMedicationOf(request)?.code ?? null) ??
  'Unknown medication'

export { displayNameOf }
