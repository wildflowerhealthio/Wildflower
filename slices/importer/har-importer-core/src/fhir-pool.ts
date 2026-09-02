import { fhirR4Source } from 'fhir-r4-source'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { rexallBeWellSource } from 'rexall-be-well-source'
import { shoppersDrugMartSource } from 'shoppers-drugmart-source'

/**
 * The registered sources whose kinds this importer recognizes and decodes
 * through — each grouping its pre-adopted kinds under a user-facing name and
 * detail. The importer's review menu groups its include toggles by these;
 * registering another source is one static append here.
 */
const fhirSources: readonly SourceDescriptor.SourceDescriptor<FhirResource>[] = [
  fhirR4Source,
  rexallBeWellSource,
  shoppersDrugMartSource,
]

/**
 * The flat pool of `HttpResponseKind`s a HAR archive's traffic is recognized and
 * decoded through — {@link fhirSources}' pre-adopted kinds flattened. Each
 * response is recognized independently, per-URL (see this package's AGENTS.md).
 */
const fhirPool: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = fhirSources.flatMap(
  (source) => source.responseKinds
)

export { fhirPool, fhirSources }
