/**
 * Fuzzy medication-name matching shared by the medication slices
 * (`medication-sponsorship`, `medication-interaction`): the minimal
 * {@link Medication} value type they all match on, name normalization, and
 * the containment-based confidence scoring.
 *
 * The FHIR R4 `MedicationRequest` adapters that build those values live behind
 * the `medication-core/fhir` subpath, so importing the matcher from here does
 * not pull in `fhir-r4`'s schemas.
 *
 * @packageDocumentation
 */
export type { Medication } from './medication.ts'

export { dedupeMedicationsByName } from './dedupe.ts'

export { normalizeName, tokenize } from './normalize.ts'

export { confidenceRank, isTokenSubset, type MatchConfidence, scoreName } from './score.ts'
