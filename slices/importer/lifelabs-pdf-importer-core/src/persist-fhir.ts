import type { Effect } from 'effect'

import {
  type FhirR4ResourcesHttpApiClient,
  persistResources,
  type ResourceWriteFailure,
} from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { withMetaSource } from 'web-trace-core/provenance'

/**
 * Write the reviewed, chosen FHIR resources to the on-device store, stamping
 * each with the source document it came from — the LifeLabs PDF descriptor's
 * `persist` sink.
 *
 * @param resources - The resources a review chose; an empty list writes nothing
 * @param sourceRef - The relative reference of the `DocumentReference` this
 *   import reads from, stamped onto every written resource's `meta.source`
 * @returns The resources that could not be written after their retries — as
 *   data ({@link ResourceWriteFailure}, structurally `importer-fundamentals`'
 *   `PersistFailure`), never failing; requires the FHIR write client
 *
 * @remarks
 * The same sink the HAR binding wraps: `withMetaSource` for the back-pointer,
 * `fhir-r4`'s {@link persistResources} for the write and its
 * failure-as-data contract. Restated here rather than imported from
 * `har-importer-core` so the two bindings stay siblings rather than one
 * depending on the other.
 */
const persistFhir = (
  resources: readonly FhirResource[],
  sourceRef: string
): Effect.Effect<readonly ResourceWriteFailure[], never, FhirR4ResourcesHttpApiClient> =>
  persistResources(resources.map((resource) => withMetaSource(resource, sourceRef)))

export { persistFhir }
