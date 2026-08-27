import { fhirR4SourceEntities } from 'fhir-r4-source'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

/**
 * The closed, compile-time flat pool of `HttpResponseKind`s a HAR archive's
 * traffic is recognized and extracted through — every source's entities in one
 * list, routed per response by `Extraction.routeTo` (highest specificity wins).
 *
 * @remarks
 * The importer is **per-URL**: each response is recognized independently against
 * this whole pool, rather than one winning `Source` claiming the archive. So a
 * mixed archive extracts every recognized URL — a stray FHIR URL inside a portal
 * capture now extracts instead of being quarantined to one source.
 *
 * Registering a source is one static edit — appending its `HttpResponseKind`s
 * (assembled in its own package under `slices/http-extraction`, the way
 * `fhir-r4-source` exports `fhirR4SourceEntities`, already keyed under the root
 * of the URL each resource arrived on). This list is HAR-detection machinery and
 * deliberately lives here rather than in the `http-extraction` slice: the
 * collector assembles its own descriptor tuple from the same source packages,
 * and the two lists have different members and payloads. Only `fhir-r4` is
 * registered so far.
 */
const pool: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = fhirR4SourceEntities

export { pool }
