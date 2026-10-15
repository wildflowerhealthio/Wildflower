import { type DateTime, Data, Either } from 'effect'

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

/** The `supply` has no `value`. */
class SupplyDurationValueAbsent extends Data.TaggedError('SupplyDurationValueAbsent') {}

/** The `supply`'s `value` is `NaN` or infinite. */
class SupplyDurationValueNotFinite extends Data.TaggedError('SupplyDurationValueNotFinite')<{
  readonly value: number
}> {}

/**
 * The `supply`'s `value` rounds to less than one of its unit: zero, negative,
 * or a sliver under one half.
 */
class SupplyDurationBelowOneUnit extends Data.TaggedError('SupplyDurationBelowOneUnit')<{
  readonly value: number
}> {}

/** Why a `SupplyDuration` gives no `DateTime.add` parts. */
type UnusableSupplyDuration =
  | SupplyDurationValueAbsent
  | SupplyDurationValueNotFinite
  | SupplyDurationBelowOneUnit

/** Builds the `DateTime.add` parts for a whole number of one unit. */
type PartBuilder = (amount: number) => Partial<DateTime.DateTime.PartsForMath>

// The day builder on its own, so the unit fallback is a defined builder rather
// than an index into a `Partial` table.
const toDays: PartBuilder = (n) => ({ days: n })

/**
 * UCUM time codes -> a builder for the matching `DateTime.add` part. Supply
 * durations are almost always days, but weeks/months are valid; an
 * unrecognized or absent unit falls back to days (see
 * {@link supplyDurationToParts}). `Partial` keeps index access
 * `PartBuilder | undefined`.
 */
const UCUM_UNIT: Partial<Record<string, PartBuilder>> = {
  s: (n) => ({ seconds: n }),
  min: (n) => ({ minutes: n }),
  h: (n) => ({ hours: n }),
  d: toDays,
  wk: (n) => ({ weeks: n }),
  mo: (n) => ({ months: n }),
  a: (n) => ({ years: n }),
}
/** Spelled-out `unit` names -> the same builders as {@link UCUM_UNIT}, matched lowercased. */
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

// Own keys only: a free-text code or unit such as `__proto__` or `toString`
// must miss the table, not find something on `Object.prototype`.
const partBuilderFor = (
  table: Partial<Record<string, PartBuilder>>,
  key: string | null | undefined
): PartBuilder | undefined =>
  key === null || key === undefined || !Object.hasOwn(table, key) ? undefined : table[key]

/**
 * The supply duration as `DateTime.add` parts, its `value` rounded to a whole
 * number of its unit. The unit is the UCUM `code` when it names one, else the
 * spelled-out `unit`, else days.
 *
 * @returns the parts on the right; on the left, which {@link UnusableSupplyDuration}
 *   case stops the supply from being a duration at all
 */
const supplyDurationToParts = (
  supply: SupplyDuration
): Either.Either<Partial<DateTime.DateTime.PartsForMath>, UnusableSupplyDuration> => {
  const { value } = supply
  if (value === null || value === undefined) return Either.left(new SupplyDurationValueAbsent())
  if (!Number.isFinite(value)) return Either.left(new SupplyDurationValueNotFinite({ value }))
  const amount = Math.round(value)
  if (amount <= 0) return Either.left(new SupplyDurationBelowOneUnit({ value }))
  const build =
    partBuilderFor(UCUM_UNIT, supply.code) ??
    partBuilderFor(SPELLED_UNIT, supply.unit?.toLowerCase()) ??
    toDays
  return Either.right(build(amount))
}

export {
  type PartBuilder,
  SPELLED_UNIT,
  type SupplyDuration,
  SupplyDurationBelowOneUnit,
  supplyDurationToParts,
  SupplyDurationValueAbsent,
  SupplyDurationValueNotFinite,
  UCUM_UNIT,
  type UnusableSupplyDuration,
}
