import { Option, pipe } from 'effect'
import { CodeableConcept } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'
import { nonEmpty } from 'kitchen-sink'

import {
  containedMedicationOf,
  medicationConceptOf,
  medicationReferenceOf,
} from './medication-slots.ts'

/** A concept's label (see `CodeableConcept.label`); `null` when there is no concept or no label. */
const conceptName = (concept: typeof CodeableConcept.Schema.Type | null): string | null =>
  pipe(Option.fromNullable(concept), Option.flatMap(CodeableConcept.label), Option.getOrNull)

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
