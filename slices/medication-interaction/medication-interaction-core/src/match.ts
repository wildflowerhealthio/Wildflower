import {
  confidenceRank,
  isTokenSubset,
  type MatchConfidence,
  scoreName,
  tokenize,
} from 'medication-matching-core'

import type { CatalogDrug, InteractionCatalog } from './ddinter.ts'

/** A catalog drug a name resolved to, with the confidence of the match. */
interface CatalogMatch {
  readonly drug: CatalogDrug
  readonly confidence: MatchConfidence
}

/** A DDInter name's tokens, dropping anything inside parentheses (route / form qualifiers such as `"(nasal)"`, or an unrelated drug's formulation note such as `"(zinc)"` in `"Insulin human (zinc)"`). */
const primaryTokens = (name: string): readonly string[] => tokenize(name.replace(/\([^)]*\)/g, ' '))

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
 * `"Iron sucrose"`), so a partial never dilutes a definite match. A partial
 * match is dropped when it only holds because of a candidate's parenthetical
 * qualifier (e.g. a bare `"Zinc"` OTC entry must not partial-match
 * `"Insulin human (zinc)"`, which is a zinc-formulated insulin, not a zinc
 * product) — {@link primaryTokens} re-checks containment with that qualifier
 * removed.
 */
const matchCatalogDrugs = (name: string, catalog: InteractionCatalog): readonly CatalogMatch[] => {
  const contained: CatalogMatch[] = []
  const partial: CatalogMatch[] = []
  for (const drug of catalog.drugs) {
    const confidence = scoreName(name, drug.name)
    if (confidence === null) continue
    if (confidenceRank[confidence] >= confidenceRank.strong) {
      contained.push({ drug, confidence })
    } else if (isTokenSubset(tokenize(name), primaryTokens(drug.name))) {
      partial.push({ drug, confidence })
    }
  }
  return contained.length > 0 ? contained : partial
}

export { type CatalogMatch, matchCatalogDrugs }
