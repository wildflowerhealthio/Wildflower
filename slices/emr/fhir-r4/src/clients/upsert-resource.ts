import { Effect } from 'effect'

import type { FhirResource } from '../resources/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'

/**
 * Route one parsed {@link FhirResource} to its typed client endpoint — the
 * single `switch (resource.resourceType)` over the FHIR write surface. It
 * lives here, next to the client whose groups it dispatches to, so every
 * FHIR-targeting collector reuses one exhaustive dispatch instead of copying
 * it (the switch a collector's `persist.ts` used to hand-roll).
 *
 * The write requirement {@link FhirR4ResourcesHttpApiClient} bubbles up as the
 * caller's `R`; app wiring provides the client layer.
 *
 * A `null` logical id is skipped defensively (a typed `Update` path needs a
 * non-null id): a resource whose entities already filtered ids can still reach
 * an untyped path, and a skip is not a failure — it resolves cleanly. The
 * caller owns everything *around* the write (batching, retries, spans, failure
 * accounting); this owns only "which resource type goes to which endpoint".
 *
 * The exhaustive-default arm `fail`s on the `unknown` error channel rather than
 * dying: an unrecognized `resourceType` can only arrive through an untyped path,
 * and a *failure* is caught by the caller's `matchEffect` and recorded as one
 * `PersistFailure`, whereas a *defect* would escape that seam and crash the whole
 * batch/run — breaking the sink's "one bad resource can't fail the run" contract
 * (the same contract the null-id skip honours).
 */
const upsertResource = (
  resource: FhirResource
): Effect.Effect<void, unknown, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    if (resource.id === null) {
      yield* Effect.logWarning(`fhir-r4 upsert: skipping ${resource.resourceType} with null id`)
      return
    }
    const client = yield* FhirR4ResourcesHttpApiClient
    const id = resource.id
    const path = { id }
    switch (resource.resourceType) {
      case 'Patient':
        yield* client.Patient.Update({ path, payload: { ...resource, id } })
        break
      case 'Observation':
        yield* client.Observation.Update({ path, payload: { ...resource, id } })
        break
      case 'Binary':
        yield* client.Binary.Update({ path, payload: { ...resource, id } })
        break
      case 'MedicationRequest':
        yield* client.MedicationRequest.Update({ path, payload: { ...resource, id } })
        break
      case 'MedicationDispense':
        yield* client.MedicationDispense.Update({ path, payload: { ...resource, id } })
        break
      default: {
        const unreachable: never = resource
        yield* Effect.fail(new Error(`fhir-r4 upsert: unknown resourceType ${String(unreachable)}`))
      }
    }
  }).pipe(Effect.asVoid)

export { upsertResource }
