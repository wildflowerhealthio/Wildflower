import { Array as Arr, DateTime, Option, pipe } from 'effect'
import { Extension, WildflowerExtension } from 'fhir-r4/data-types'
import type { MedicationRequest } from 'fhir-r4/resources'
import { nextFillDate } from 'medication-calendar-core'

/** What `dispenseRequest` says about supply: repeats, and when the next fill falls due. */

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
const nextFillDateOf = (request: MedicationRequest.Type): string | null => {
  const authored = request.authoredOn
  const supply = request.dispenseRequest?.expectedSupplyDuration
  if (authored === null || supply === null || supply === undefined) return null
  return nextFillDate(DateTime.formatIso(authored), supply)
}

export { nextFillDateOf, repeatsAllowedOf, repeatsAvailableOf }
