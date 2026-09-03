import { normalizeName, tokenize } from './normalize.ts'

/**
 * How confident a name match is:
 * - `exact`   — the medication name normalizes to exactly the candidate name.
 * - `strong`  — the candidate name is fully contained in the medication name,
 *   e.g. `"Abilify"` inside `"Abilify 5 mg tablet"`.
 * - `partial` — the medication name is fully contained in the candidate name,
 *   e.g. medication `"risedronate"` against candidate `"risedronate sodium"`.
 */
type MatchConfidence = 'exact' | 'strong' | 'partial'

/** Numeric rank so confidences can be compared / maximized (higher is better). */
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
 * Score one candidate name (a catalog drug's brand or generic) against a
 * medication name.
 *
 * @param medName - The medication's display name, as the adapter produced it
 * @param candidate - The catalog name to score it against
 * @returns The {@link MatchConfidence}, or `null` when there is no reasonable match
 *
 * @remarks
 * Both names go through {@link normalizeName} first, so markup, marks and
 * dosage / strength tokens never decide a match. Either side normalizing to the
 * empty string is `null`: an empty needle would otherwise be "contained" in
 * everything.
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

export { confidenceRank, isTokenSubset, scoreName, type MatchConfidence }
