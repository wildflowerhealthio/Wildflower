import type { DateTime } from 'effect'

/**
 * A supply-duration quantity: a numeric `value` with a UCUM `code` and/or a
 * spelled-out `unit`. Mirrors the shape a FHIR `Duration`
 * (`MedicationRequest.dispenseRequest.expectedSupplyDuration`) feeds in,
 * without importing the FHIR wire schemas — every field is nullable because
 * the source resource may omit any of them, and a caller can hand in either a
 * decoded resource or its own mirror of the same slot.
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

export { type PartBuilder, SPELLED_UNIT, type SupplyDuration, supplyDurationToParts, UCUM_UNIT }
