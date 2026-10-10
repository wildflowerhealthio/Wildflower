import { Extension, WildflowerExtension } from '@wildflowerhealthio/fhir-r4/data-types'
import type { MedicationRequest } from '@wildflowerhealthio/fhir-r4/resources'
import { supplyDurationToParts } from '@wildflowerhealthio/fhir-utility'
import { nextFillDate } from '@wildflowerhealthio/medication-calendar-core'
import { Array as Arr, DateTime, Option, pipe, Record as EffectRecord } from 'effect'

/**
 * What `dispenseRequest` says about supply: repeats, when the next fill falls
 * due, how many days one fill lasts, and when the whole authorized supply runs
 * out.
 */

/** `dispenseRequest.numberOfRepeatsAllowed` — the total repeats authorized. */
const repeatsAllowedOf = (request: MedicationRequest.Type): number | null =>
  request.dispenseRequest?.numberOfRepeatsAllowed ?? null

/** An extension's `valueInteger`, when it carries one. */
const valueIntegerOf = (extension: Extension.Type): Option.Option<number> =>
  Option.fromNullable(extension.valueInteger)

/**
 * The repeats still available: the {@link WildflowerExtension.RepeatsAvailable}
 * `valueInteger` on `dispenseRequest.extension`. R4 has no standard slot for
 * it, only the total {@link repeatsAllowedOf}.
 */
const repeatsAvailableOf = (request: MedicationRequest.Type): number | null =>
  pipe(
    request.dispenseRequest?.extension ?? [],
    Arr.filter(Extension.hasUrl(WildflowerExtension.RepeatsAvailable)),
    Arr.findFirst(valueIntegerOf),
    Option.getOrNull
  )

/**
 * Estimated next-fill date as an ISO instant: `authoredOn` advanced by
 * `dispenseRequest.expectedSupplyDuration` (when the current supply runs out).
 * `null` unless both are present. The date math is `medication-calendar-core`'s
 * `nextFillDate`.
 *
 * @remarks
 * `dispenseRequest.validityPeriod.end` is the *authorization* expiry in R4, not
 * a fill date, so it is deliberately not a fallback.
 */
const nextFillDateOf = (request: MedicationRequest.Type): string | null =>
  pipe(
    Option.all({
      authored: Option.fromNullable(request.authoredOn),
      supply: Option.fromNullable(request.dispenseRequest?.expectedSupplyDuration),
    }),
    Option.map(({ authored, supply }) => nextFillDate(DateTime.formatIso(authored), supply)),
    Option.getOrNull
  )

/**
 * When the whole authorized supply runs out: `supplyStart` advanced by
 * `dispenseRequest.expectedSupplyDuration` once for the first fill and once
 * per `numberOfRepeatsAllowed`.
 *
 * @returns `null` when there is no usable supply duration (see
 *   `fhir-utility`'s `supplyDurationToParts`, which `nextFillDateOf` advances
 *   by too), or the advance leaves the representable date range
 */
const authorizedSupplyEndOf = (
  request: MedicationRequest.Type,
  supplyStart: DateTime.Utc
): DateTime.Utc | null => {
  const expectedSupplyDuration = request.dispenseRequest?.expectedSupplyDuration ?? null
  if (expectedSupplyDuration === null || expectedSupplyDuration.value === null) return null
  const fillCount = (request.dispenseRequest?.numberOfRepeatsAllowed ?? 0) + 1
  const authorizedSupplyDuration = supplyDurationToParts({
    ...expectedSupplyDuration,
    value: expectedSupplyDuration.value * fillCount,
  })
  if (authorizedSupplyDuration === null) return null
  const supplyEnd = DateTime.add(supplyStart, authorizedSupplyDuration)
  return Number.isFinite(supplyEnd.epochMillis) ? supplyEnd : null
}

/**
 * Days per `DateTime.add` part, for converting a supply duration read by
 * `supplyDurationToParts` to days. A month is taken as 30 days, as
 * `timing.ts`'s `DAYS_PER_PERIOD_UNIT` takes it, and a year as 365.
 */
const DAYS_PER_SUPPLY_PART: Readonly<Record<keyof DateTime.DateTime.PartsForMath, number>> = {
  millis: 1 / 86_400_000,
  seconds: 1 / 86_400,
  minutes: 1 / 1440,
  hours: 1 / 24,
  days: 1,
  weeks: 7,
  months: 30,
  years: 365,
}

/** The number of days a set of `DateTime.add` parts spans, by {@link DAYS_PER_SUPPLY_PART}. */
const supplyPartsToDays = (supplyParts: Partial<DateTime.DateTime.PartsForMath>): number =>
  EffectRecord.reduce(
    DAYS_PER_SUPPLY_PART,
    0,
    (days, daysPerPart, part) => days + (supplyParts[part] ?? 0) * daysPerPart
  )

/**
 * How many days one fill's supply lasts: `dispenseRequest.expectedSupplyDuration`
 * read by `fhir-utility`'s `supplyDurationToParts` — the parser
 * {@link authorizedSupplyEndOf} advances by — and converted to days by
 * {@link DAYS_PER_SUPPLY_PART}.
 *
 * @returns `null` when there is no usable supply duration, or it comes to no
 *   positive, finite number of days
 */
const supplyDaysPerFillOf = (request: MedicationRequest.Type): number | null => {
  const expectedSupplyDuration = request.dispenseRequest?.expectedSupplyDuration ?? null
  if (expectedSupplyDuration === null) return null
  const supplyParts = supplyDurationToParts(expectedSupplyDuration)
  if (supplyParts === null) return null
  const supplyDays = supplyPartsToDays(supplyParts)
  return supplyDays > 0 && Number.isFinite(supplyDays) ? supplyDays : null
}

export {
  authorizedSupplyEndOf,
  nextFillDateOf,
  repeatsAllowedOf,
  repeatsAvailableOf,
  supplyDaysPerFillOf,
}
