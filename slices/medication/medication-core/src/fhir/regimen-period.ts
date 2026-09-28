import { DateTime } from 'effect'
import type { MedicationRequest } from 'fhir-r4/resources'

import { authorizedSupplyEndOf } from './dispense-request.ts'

/** When a request's dose regimen is in effect: where it starts, and where it ends. */

/** When a regimen begins: `dispenseRequest.validityPeriod.start`, else `authoredOn`. */
const regimenStartOf = (request: MedicationRequest.Type): DateTime.Utc | null =>
  request.dispenseRequest?.validityPeriod?.start ?? request.authoredOn

/**
 * When a regimen ends: `dispenseRequest.validityPeriod.end`, else the
 * {@link authorizedSupplyEndOf} estimate counted from `regimenStart`, else open
 * (`null`) while the request is `active` and `regimenStart` itself otherwise.
 *
 * @remarks
 * A stated or estimated end before `regimenStart` is raised to it, so a
 * regimen never runs backwards.
 */
const regimenEndOf = (
  request: MedicationRequest.Type,
  regimenStart: DateTime.Utc
): DateTime.Utc | null => {
  const validityOrSupplyEnd =
    request.dispenseRequest?.validityPeriod?.end ?? authorizedSupplyEndOf(request, regimenStart)
  if (validityOrSupplyEnd !== null) return DateTime.max(regimenStart, validityOrSupplyEnd)
  return request.status === 'active' ? null : regimenStart
}

export { regimenEndOf, regimenStartOf }
