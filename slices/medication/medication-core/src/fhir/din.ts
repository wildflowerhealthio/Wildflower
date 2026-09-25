import { Array as Arr, Option, pipe, String as Str } from 'effect'
import { CanadianCodingSystem, Coding, type CodeableConcept } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'

import { containedMedicationOf, medicationConceptOf } from './medication-slots.ts'

/** A coding's `code`, when it carries a non-blank one. */
const nonEmptyCodeOf = (coding: Coding.Type): Option.Option<string> =>
  pipe(Option.fromNullable(coding.code), Option.filter(Str.isNonEmpty))

/** The first non-empty `code` under {@link CanadianCodingSystem.Din} in a concept. */
const canonicalDinIn = (concept: typeof CodeableConcept.Schema.Type | null): string | null =>
  pipe(
    concept?.coding ?? [],
    Arr.filter(Coding.isInSystem(CanadianCodingSystem.Din)),
    Arr.findFirst(nonEmptyCodeOf),
    Option.getOrNull
  )

/**
 * The Drug Identification Number: the {@link CanadianCodingSystem.Din} coding
 * on the contained Medication's `code`, else on `medicationCodeableConcept`.
 *
 * @remarks
 * Only the canonical system is read. A source keeps any vendor DIN coding
 * beside it, and a drug vocabulary that is not a DIN (RxNorm, SNOMED CT) must
 * never print as one.
 */
const dinOf = (request: MedicationRequest.Type): string | null =>
  canonicalDinIn(containedMedicationOf(request)?.code ?? null) ??
  canonicalDinIn(medicationConceptOf(request))

export { dinOf }
