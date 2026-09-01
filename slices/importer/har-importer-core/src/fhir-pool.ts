import { fhirR4Source } from 'fhir-r4-source'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'

/** The registered sources whose kinds this importer's pool flattens. */
const sources: readonly SourceDescriptor.SourceDescriptor<FhirResource>[] = [fhirR4Source]

/**
 * The flat pool of `HttpResponseKind`s a HAR archive's traffic is recognized and
 * decoded through — every registered source's kinds, already keyed under the
 * root of the URL each resource arrived on (consumed pre-adopted, never
 * re-adopted here).
 *
 * @remarks
 * The importer is **per-URL**: each response is recognized independently against
 * this whole pool (highest specificity wins), rather than one winning source
 * claiming the archive. So a mixed archive extracts every recognized URL — a
 * stray FHIR URL inside a portal capture extracts instead of being quarantined.
 *
 * Registering another source is one static append to {@link sources} of its
 * `SourceDescriptor` (assembled in its own package under
 * `slices/http-extraction`). Only `fhir-r4` is registered so far. The collector
 * assembles its own descriptor tuple from the same source packages; the two
 * lists have different members and payloads, which is why this HAR-detection
 * pool lives here rather than in the `http-extraction` slice.
 */
const fhirPool: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = sources.flatMap(
  (source) => source.responseKinds
)

export { fhirPool }
