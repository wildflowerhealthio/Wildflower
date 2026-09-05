import { DateTime, Option } from 'effect'
import { type SupplyDuration, supplyDurationToParts } from 'fhir-utility'

/**
 * Estimated next-fill date as an ISO instant: `authoredOnIso` advanced by
 * `supply` (i.e. when the current supply runs out). `null` unless the authored
 * date parses and the supply duration is usable — total, never throws.
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
  return DateTime.formatIso(DateTime.add(authored.value, parts))
}

export { nextFillDate }
