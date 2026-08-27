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
 * each with the archive it came from — the HAR descriptor's `persist` sink.
 *
 * @param resources - The resources a review chose; an empty list writes nothing
 * @param sourceRef - The relative reference of the HAR-archive
 *   `DocumentReference` this import reads from (`DocumentReference/<id>`),
 *   stamped onto every written resource's `meta.source`
 * @returns The resources that could not be written after their retries — as
 *   data ({@link ResourceWriteFailure}, structurally `importer-fundamentals`'
 *   `PersistFailure`), never failing; requires the FHIR write client
 *
 * @remarks
 * Each resource is linked back to its source archive with `web-trace-core`'s
 * {@link withMetaSource}, which sets `meta.source` while preserving whatever else
 * the resource's `meta` carried — the same single-valued back-pointer the live
 * collection path writes, here naming the uploaded archive rather than a
 * per-response trace. The write itself is `fhir-r4`'s {@link persistResources}:
 * bounded retries, a per-resource span, bounded concurrency, and — the property
 * this delegates for — failure-as-data, so one failing write is returned rather
 * than stopping the batch. Nothing here throws. An empty `resources` never
 * touches the client.
 */
const persistFhir = (
  resources: readonly FhirResource[],
  sourceRef: string
): Effect.Effect<readonly ResourceWriteFailure[], never, FhirR4ResourcesHttpApiClient> =>
  persistResources(resources.map((resource) => withMetaSource(resource, sourceRef)))

export { persistFhir }
