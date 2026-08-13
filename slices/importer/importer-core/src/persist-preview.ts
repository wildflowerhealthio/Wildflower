import { Effect } from 'effect'

import {
  type FhirR4ResourcesHttpApiClient,
  persistResources,
  type ResourceWriteFailure,
} from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { withMetaSource } from 'web-trace-core/provenance'

import type { ImportPreview } from './import-preview.ts'

/**
 * Write a previewed import to the on-device FHIR R4 store — the opt-in second
 * half of the flow, run only after a user confirms a {@link ImportPreview}.
 */

/**
 * Persist every resource a preview would write, stamping each with the archive
 * it came from.
 *
 * @param preview - The preview to persist; a `NoCollectorClaims` writes nothing
 * @param sourceRef - The relative reference of the HAR-archive
 *   `DocumentReference` this import reads from (`DocumentReference/<id>`),
 *   stamped onto every written resource's `meta.source`
 * @returns The resources that could not be written after their retries — as
 *   data, never failing; requires the FHIR write client
 *
 * @remarks
 * The resources are flattened out of `resourcesByType` and each is linked back
 * to its source archive with `web-trace-core`'s {@link withMetaSource}, which
 * sets `meta.source` while preserving whatever else the resource's `meta`
 * carried — the same single-valued back-pointer a live collector writes, here
 * naming the uploaded archive rather than a per-response trace. The write itself
 * is `fhir-r4`'s {@link persistResources}: bounded retries, a per-resource span,
 * bounded concurrency, and — the property this delegates for — failure-as-data,
 * so one failing write is returned as a {@link ResourceWriteFailure} and never
 * stops the rest of the batch. Nothing here throws.
 *
 * A `NoCollectorClaims` preview has nothing to write, so this is an immediate
 * empty result that does not even touch the client.
 */
const persistPreview = (
  preview: ImportPreview,
  sourceRef: string
): Effect.Effect<ReadonlyArray<ResourceWriteFailure>, never, FhirR4ResourcesHttpApiClient> => {
  if (preview._tag === 'NoCollectorClaims') {
    return Effect.succeed([])
  }
  const resources: readonly FhirResource[] = Object.values(preview.resourcesByType)
    .flat()
    .map((resource) => withMetaSource(resource, sourceRef))
  return persistResources(resources)
}

export { persistPreview }
