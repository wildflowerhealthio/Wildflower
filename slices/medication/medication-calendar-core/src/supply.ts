import { type SupplyDuration, supplyDurationToParts } from '@wildflowerhealthio/fhir-utility'
import { DateTime, Option } from 'effect'

/**
 * Estimated next-fill date as an ISO instant: `authoredOnIso` advanced by
 * `supply` (i.e. when the current supply runs out). `null` unless the authored
 * date parses, the supply duration is usable, and the advanced instant stays
 * within the representable date range — total, never throws.
 *
 * The authored date is taken as an ISO string (not a parsed instant) so this
 * stays FHIR-free; the caller formats its decoded date to ISO first. The
 * `SupplyDuration` shape and parser come from `fhir-utility` — a supply
 * duration is a FHIR concept, not a calendar one.
 */
const nextFillDate = (authoredOnIso: string, supply: SupplyDuration): string | null => {
  const parts = supplyDurationToParts(supply)
  if (parts === null) return null
  const authored = DateTime.make(authoredOnIso)
  if (Option.isNone(authored)) return null
  const exhausted = DateTime.add(authored.value, parts)
  return Number.isFinite(exhausted.epochMillis) ? DateTime.formatIso(exhausted) : null
}

export { nextFillDate }
