import { normalizeName, tokenize } from './normalize.ts'
import type { Medication, SponsoredDrug } from './sponsor.ts'

/** Which name on the drug produced the match. */
type MatchField = 'brand' | 'generic'

/**
 * How confident the match is:
 * - `exact`   — the medication name normalizes to exactly the drug name.
 * - `strong`  — the drug's (brand/generic) name is fully contained in the med
 *   name, e.g. `"Abilify"` inside `"Abilify 5 mg tablet"`.
 * - `partial` — the med name is fully contained in the drug's name, e.g. med
 *   `"risedronate"` against generic `"risedronate sodium"`.
 */
type MatchConfidence = 'exact' | 'strong' | 'partial'

interface DrugMatch {
  readonly drug: SponsoredDrug
  readonly field: MatchField
  readonly confidence: MatchConfidence
}

/** Numeric rank so matches can be compared / maximized. */
const confidenceRank: Readonly<Record<MatchConfidence, number>> = {
  exact: 3,
  strong: 2,
  partial: 1,
}

/** Is every token of `needle` present in `haystack`? (empty needle → false). */
const isTokenSubset = (needle: readonly string[], haystack: readonly string[]): boolean => {
  if (needle.length === 0) return false
  const present = new Set(haystack)
  return needle.every((token) => present.has(token))
}

/**
 * Score one candidate name (a drug's brand or generic) against a medication
 * name. Returns `null` when there is no reasonable match.
 */
const scoreName = (medName: string, candidate: string): MatchConfidence | null => {
  const med = normalizeName(medName)
  const cand = normalizeName(candidate)
  if (med.length === 0 || cand.length === 0) return null
  if (med === cand) return 'exact'
  const medTokens = tokenize(medName)
  const candTokens = tokenize(candidate)
  if (isTokenSubset(candTokens, medTokens)) return 'strong'
  if (isTokenSubset(medTokens, candTokens)) return 'partial'
  return null
}

/**
 * Best match of a medication against a single drug, preferring the brand name
 * over the generic at equal confidence. `null` when neither name matches.
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
