/**
 * Fuzzy medication-name matching shared by the medication slices
 * (`medication-sponsorship`, `medication-interaction`): the minimal
 * {@link Medication} value type they all match on, name normalization, and
 * the containment-based confidence scoring.
 *
 * @packageDocumentation
 */
export type { Medication } from './medication.ts'

export { normalizeName, tokenize } from './normalize.ts'

export { confidenceRank, isTokenSubset, type MatchConfidence, scoreName } from './score.ts'
