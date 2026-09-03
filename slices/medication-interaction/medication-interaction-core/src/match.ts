import { confidenceRank, type MatchConfidence, scoreName } from 'medication-matching-core'

import type { CatalogDrug, InteractionCatalog } from './ddinter.ts'

/** A catalog drug a name resolved to, with the confidence of the match. */
interface CatalogMatch {
  readonly drug: CatalogDrug
  readonly confidence: MatchConfidence
}

/**
 * Every catalog drug a medication name resolves to.
 *
 * @param name - A medication display name (or an OTC / non-drug name)
 * @param catalog - The decoded DDInter catalog
 * @returns Matches in catalog order; empty when nothing matches
 *
 * @remarks
 * Interaction checking needs _every_ ingredient of a combination product, so
 * unlike sponsorship's best-single-drug matcher this returns all drugs whose
 * name is contained in `name` (`exact` or `strong` — "Acetaminophen with
 * codeine" yields both). Only when no name is contained does it fall back to
 * the `partial` grade (the name contained in a drug's, e.g. `"iron"` in
 * `"Iron sucrose"`), so a partial never dilutes a definite match.
 */
const matchCatalogDrugs = (name: string, catalog: InteractionCatalog): readonly CatalogMatch[] => {
  const contained: CatalogMatch[] = []
  const partial: CatalogMatch[] = []
  for (const drug of catalog.drugs) {
    const confidence = scoreName(name, drug.name)
    if (confidence === null) continue
    if (confidenceRank[confidence] >= confidenceRank.strong) contained.push({ drug, confidence })
    else partial.push({ drug, confidence })
  }
  return contained.length > 0 ? contained : partial
}

export { type CatalogMatch, matchCatalogDrugs }
