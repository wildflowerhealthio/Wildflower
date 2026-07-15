import type { CollectorDescriptor } from 'collector-fundamentals/model'
import { Effect } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'

import type { AnyResource } from './config.ts'

/**
 * Route one parsed FHIR resource to its typed client endpoint.
 *
 * This is the write switch that used to live in `collector-react`'s sync
 * runner as `writeResourceWithRetries` — FHIR knowledge embedded in the
 * generic runner, and the reason `AnyCollectorResource` had to be a
 * cross-package union. It now belongs to the FHIR collector's descriptor
 * (3B of epic #382): the runner injects this as the descriptor's
 * `persistResource` sink and owns everything *around* the write — batching,
 * `WRITE_CONCURRENCY`, the retry/backoff schedule, spans, and failure
 * accounting. This function owns only "which resource type goes to which
 * endpoint".
 *
 * The write requirement `FhirR4ResourcesHttpApiClient` bubbles up as the
 * descriptor's `R`; the app wiring provides the client layer (the FHIR
 * slice's own), so the collector slice never self-provides it.
 *
 * Null-id resources are skipped defensively: the entities filter them
 * before emitting, but a typed `path` still needs a non-null id
 * (coordinate with #377's null-id semantics — do not duplicate). A skipped
 * resource is not a failure; it resolves cleanly.
 */
const persistResource = (
  resource: AnyResource
): Effect.Effect<void, unknown, FhirR4ResourcesHttpApiClient> =>
  Effect.gen(function* () {
    if (resource.id === null) {
      yield* Effect.logWarning('fhir-r4 persist: skipping resource with null id')
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
        yield* Effect.dieMessage(`fhir-r4 persist: unknown resourceType ${String(unreachable)}`)
      }
    }
  }).pipe(Effect.asVoid)

/**
 * Describe a FHIR resource for the runner's telemetry and `partial`
 * failure summary — `kind` is the FHIR `resourceType`, `id` its logical
 * id (falling back to a sentinel for the null-id case that
 * {@link persistResource} skips, so the runner never has to inspect a
 * resource's id itself).
 */
const describeResource = (resource: AnyResource): CollectorDescriptor.ResourceDescription => ({
  kind: resource.resourceType,
  id: resource.id ?? '<no-id>',
})

export { persistResource, describeResource }
