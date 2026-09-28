import { Array as Arr, DateTime, Option, pipe } from 'effect'
import { Extension, WildflowerExtension } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'
import { supplyDurationToParts } from 'fhir-utility'
import { nextFillDate } from 'medication-calendar-core'

/**
 * What `dispenseRequest` says about supply: repeats, when the next fill falls
 * due, and when the whole authorized supply runs out.
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

export { authorizedSupplyEndOf, nextFillDateOf, repeatsAllowedOf, repeatsAvailableOf }
