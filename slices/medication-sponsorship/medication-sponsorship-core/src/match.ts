import {
  confidenceRank,
  type MatchConfidence,
  type Medication,
  scoreName,
} from 'medication-matching-core'

import type { SponsoredDrug } from './sponsor.ts'

/** Which name on the drug produced the match. */
type MatchField = 'brand' | 'generic'

interface DrugMatch {
  readonly drug: SponsoredDrug
  readonly field: MatchField
  readonly confidence: MatchConfidence
}

/**
 * Best match of a medication against a single drug, preferring the brand name
 * over the generic at equal confidence. `null` when neither name matches.
 * Confidence is `medication-matching-core`'s {@link scoreName} grade.
 */
const matchDrug = (med: Medication, drug: SponsoredDrug): DrugMatch | null => {
  const brand = scoreName(med.displayName, drug.brandName)
  const generic = scoreName(med.displayName, drug.genericName)
  const brandMatch: DrugMatch | null =
    brand === null ? null : { drug, field: 'brand', confidence: brand }
  const genericMatch: DrugMatch | null =
    generic === null ? null : { drug, field: 'generic', confidence: generic }
  if (brandMatch === null) return genericMatch
  if (genericMatch === null) return brandMatch
  // Both matched: brand wins ties, generic only if strictly more confident.
  return confidenceRank[genericMatch.confidence] > confidenceRank[brandMatch.confidence]
    ? genericMatch
    : brandMatch
}

/**
 * Best match of a medication against a list of drugs. On ties the earlier drug
 * in the list wins (only a strictly higher confidence displaces it), so the
 * caller controls preference through list order.
 */
const matchMedication = (med: Medication, drugs: readonly SponsoredDrug[]): DrugMatch | null =>
  drugs.reduce<DrugMatch | null>((best, drug) => {
    const candidate = matchDrug(med, drug)
    if (candidate === null) return best
    if (best === null) return candidate
    return confidenceRank[candidate.confidence] > confidenceRank[best.confidence] ? candidate : best
  }, null)

export { matchDrug, matchMedication, type MatchField, type MatchConfidence, type DrugMatch }
