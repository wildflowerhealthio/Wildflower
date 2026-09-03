import { DateTime, Option } from 'effect'

import type { Medication } from './medication.ts'

/**
 * The instant a medication was authored, or `None` when it has no `authoredOn`
 * or the value does not parse. FHIR `authoredOn` is a `dateTime`, so a value may
 * be a bare date, a datetime, or a datetime carrying a timezone offset;
 * {@link DateTime.make} normalizes all of these to the same UTC scale, where a
 * raw string compare would mis-order two instants written in different offsets.
 */
const authoredAt = (medication: Medication): Option.Option<DateTime.Utc> =>
  medication.authoredOn === undefined ? Option.none() : DateTime.make(medication.authoredOn)

/**
 * Whether `candidate` is more recent than `incumbent` by `authoredOn`. A missing
 * or unparseable date is treated as oldest, and an exact tie keeps the incumbent
 * (so the first seen wins).
 */
const isNewer = (candidate: Medication, incumbent: Medication): boolean => {
  const candidateAt = authoredAt(candidate)
  const incumbentAt = authoredAt(incumbent)
  if (Option.isNone(candidateAt)) return false
  if (Option.isNone(incumbentAt)) return true
  return DateTime.greaterThan(candidateAt.value, incumbentAt.value)
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
