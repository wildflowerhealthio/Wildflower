import { Extension, WildflowerExtension } from '@wildflowerhealthio/fhir-r4/data-types'
import type { MedicationRequest } from '@wildflowerhealthio/fhir-r4/resources'
import { supplyDurationToParts } from '@wildflowerhealthio/fhir-utility'
import { nextFillDate } from '@wildflowerhealthio/medication-calendar-core'
import { Array as Arr, DateTime, Either, Option, pipe, Record as EffectRecord } from 'effect'

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
 * `null` when either is absent, or `medication-calendar-core`'s `nextFillDate`
 * — which does the date math — fails with any `NextFillDateFailure` (an
 * unusable supply duration, or an advance out of the representable range).
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
    Option.flatMap(({ authored, supply }) =>
      Either.getRight(nextFillDate(DateTime.formatIso(authored), supply))
    ),
    Option.getOrNull
  )

/**
 * When the whole authorized supply runs out: `supplyStart` advanced by
 * `dispenseRequest.expectedSupplyDuration` once for the first fill and once
 * per `numberOfRepeatsAllowed`.
 *
 * @returns `null` when there is no supply duration, `fhir-utility`'s
 *   `supplyDurationToParts` (which `nextFillDateOf` advances by too) finds the
 *   authorized total unusable, or the advance leaves the representable date
 *   range
 */
const authorizedSupplyEndOf = (
  request: MedicationRequest.Type,
  supplyStart: DateTime.Utc
): DateTime.Utc | null => {
  const fillCount = (request.dispenseRequest?.numberOfRepeatsAllowed ?? 0) + 1
  return pipe(
    Option.fromNullable(request.dispenseRequest?.expectedSupplyDuration),
    Option.flatMap((perFill) =>
      Either.getRight(
        supplyDurationToParts({
          ...perFill,
          value: perFill.value === null ? null : perFill.value * fillCount,
        })
      )
    ),
    Option.map((authorizedSupplyDuration) => DateTime.add(supplyStart, authorizedSupplyDuration)),
    Option.filter((supplyEnd) => Number.isFinite(supplyEnd.epochMillis)),
    Option.getOrNull
  )
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
 * @returns `null` when there is no supply duration, `supplyDurationToParts`
 *   finds it unusable, or it comes to no positive, finite number of days
 */
const supplyDaysPerFillOf = (request: MedicationRequest.Type): number | null =>
  pipe(
    Option.fromNullable(request.dispenseRequest?.expectedSupplyDuration),
    Option.flatMap((perFill) => Either.getRight(supplyDurationToParts(perFill))),
    Option.map(supplyPartsToDays),
    Option.filter((supplyDays) => supplyDays > 0 && Number.isFinite(supplyDays)),
    Option.getOrNull
  )

export {
  authorizedSupplyEndOf,
  nextFillDateOf,
  repeatsAllowedOf,
  repeatsAvailableOf,
  supplyDaysPerFillOf,
}
