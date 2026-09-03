import type { Medication } from './medication.ts'

/**
 * Whether `candidate` is more recent than `incumbent` by `authoredOn`. A
 * missing date is treated as oldest, and an exact tie keeps the incumbent (so
 * the first seen wins). ISO-8601 dates order correctly under string compare.
 */
const isNewer = (candidate: Medication, incumbent: Medication): boolean => {
  if (candidate.authoredOn === undefined) return false
  if (incumbent.authoredOn === undefined) return true
  return candidate.authoredOn > incumbent.authoredOn
}

/**
 * Collapse medications that share an exact `displayName`, keeping the most
 * recent instance (greatest `authoredOn`; ties and missing dates keep the first
 * seen). Order follows each name's first appearance.
 *
 * @param medications - The medications to de-duplicate
 * @returns One medication per distinct `displayName`, first-appearance order
 *
 * @remarks
 * Matching is exact and case-sensitive on purpose: `"Tylenol"` and
 * `"Tylenol 500mg"` are left as distinct entries rather than risk merging two
 * genuinely different prescriptions.
 */
const dedupeMedicationsByName = (medications: readonly Medication[]): readonly Medication[] => {
  // Map keeps first-insertion key order even when a value is later replaced, so
  // its values are the survivors in first-appearance order.
  const winners = new Map<string, Medication>()
  for (const medication of medications) {
    const incumbent = winners.get(medication.displayName)
    if (incumbent === undefined || isNewer(medication, incumbent)) {
      winners.set(medication.displayName, medication)
    }
  }
  return [...winners.values()]
}

export { dedupeMedicationsByName }
