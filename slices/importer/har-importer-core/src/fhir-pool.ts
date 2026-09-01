import { fhirR4Source } from 'fhir-r4-source'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { shoppersDrugMartSource } from 'shoppers-drugmart-source'

/** The registered sources whose kinds this importer's pool flattens. */
const sources: readonly SourceDescriptor.SourceDescriptor<FhirResource>[] = [
  fhirR4Source,
  shoppersDrugMartSource,
]

/**
 * The flat pool of `HttpResponseKind`s a HAR archive's traffic is recognized and
 * decoded through — every registered source's kinds, already keyed under the
 * root of the URL each resource arrived on (consumed pre-adopted, never
 * re-adopted here).
 *
 * @remarks
 * Each response is recognized independently against this whole pool — per-URL,
 * never one winning source claiming the archive (see this package's AGENTS.md).
 * Registering another source is one static append of its `SourceDescriptor` to
 * {@link sources}; only `fhir-r4` is registered so far.
 */
const fhirPool: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = sources.flatMap(
  (source) => source.responseKinds
)

export { fhirPool }
