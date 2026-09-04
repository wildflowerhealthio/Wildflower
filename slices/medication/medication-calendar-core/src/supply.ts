import { DateTime, Option } from 'effect'

/**
 * A supply-duration quantity: a numeric `value` with a UCUM `code` and/or a
 * spelled-out `unit`. Mirrors the shape a FHIR `Duration`
 * (`dispenseRequest.expectedSupplyDuration`) feeds in, without importing FHIR —
 * every field is nullable because the source resource may omit any of them.
 */
interface SupplyDuration {
  readonly value: number | null | undefined
  readonly unit: string | null | undefined
  readonly code: string | null | undefined
}

// UCUM time codes and their spelled-out `unit` fallbacks -> a builder for the
// matching `DateTime.add` part. Supply durations are almost always days, but
// weeks/months are valid; an unrecognized or absent unit falls back to days
// (see `supplyDurationToParts`). `Partial` keeps index access `Builder | undefined`.
type PartBuilder = (amount: number) => Partial<DateTime.DateTime.PartsForMath>
const UCUM_UNIT: Partial<Record<string, PartBuilder>> = {
  s: (n) => ({ seconds: n }),
  min: (n) => ({ minutes: n }),
  h: (n) => ({ hours: n }),
  d: (n) => ({ days: n }),
  wk: (n) => ({ weeks: n }),
  mo: (n) => ({ months: n }),
  a: (n) => ({ years: n }),
}
const SPELLED_UNIT: Partial<Record<string, PartBuilder>> = {
  second: UCUM_UNIT.s,
  seconds: UCUM_UNIT.s,
  minute: UCUM_UNIT.min,
  minutes: UCUM_UNIT.min,
  hour: UCUM_UNIT.h,
  hours: UCUM_UNIT.h,
  day: UCUM_UNIT.d,
  days: UCUM_UNIT.d,
  week: UCUM_UNIT.wk,
  weeks: UCUM_UNIT.wk,
  month: UCUM_UNIT.mo,
  months: UCUM_UNIT.mo,
  year: UCUM_UNIT.a,
  years: UCUM_UNIT.a,
}

/** The supply duration as `DateTime.add` parts, or `null` if unusable. */
const supplyDurationToParts = (
  supply: SupplyDuration
): Partial<DateTime.DateTime.PartsForMath> | null => {
  const { value } = supply
  if (value === null || value === undefined || value <= 0) return null
  const fromCode =
    supply.code === null || supply.code === undefined ? undefined : UCUM_UNIT[supply.code]
  const fromUnit =
    supply.unit === null || supply.unit === undefined
      ? undefined
      : SPELLED_UNIT[supply.unit.toLowerCase()]
  const build = fromCode ?? fromUnit ?? UCUM_UNIT.d
  return build === undefined ? null : build(Math.round(value))
}

/**
 * Estimated next-fill date as an ISO instant: `authoredOnIso` advanced by
 * `supply` (i.e. when the current supply runs out). `null` unless the authored
 * date parses and the supply duration is usable — total, never throws.
 *
 * The authored date is taken as an ISO string (not a parsed instant) so this
 * stays FHIR-free; the caller formats its decoded date to ISO first.
 */
const nextFillDate = (authoredOnIso: string, supply: SupplyDuration): string | null => {
  const parts = supplyDurationToParts(supply)
  if (parts === null) return null
  const authored = DateTime.make(authoredOnIso)
  if (Option.isNone(authored)) return null
  return DateTime.formatIso(DateTime.add(authored.value, parts))
}

export {
  nextFillDate,
  type PartBuilder,
  SPELLED_UNIT,
  type SupplyDuration,
  supplyDurationToParts,
  UCUM_UNIT,
}
