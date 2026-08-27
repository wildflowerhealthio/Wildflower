import { fhirR4SourceEntities } from 'fhir-r4-source'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'

/**
 * The flat pool of `HttpResponseKind`s a HAR archive's traffic is recognized and
 * decoded through — the FHIR R4 source's entities, already keyed under the root
 * of the URL each resource arrived on (`fhirR4SourceEntities`, consumed
 * pre-adopted, never re-adopted here).
 *
 * @remarks
 * The importer is **per-URL**: each response is recognized independently against
 * this whole pool (highest specificity wins), rather than one winning source
 * claiming the archive. So a mixed archive extracts every recognized URL — a
 * stray FHIR URL inside a portal capture extracts instead of being quarantined.
 *
 * Registering another source is one static append here of its `HttpResponseKind`s
 * (assembled in its own package under `slices/http-extraction`). Only `fhir-r4`
 * is registered so far. The collector assembles its own descriptor tuple from
 * the same source packages; the two lists have different members and payloads,
 * which is why this HAR-detection pool lives here rather than in the
 * `http-extraction` slice.
 */
const fhirPool: readonly HttpResponseKind.HttpResponseKind<FhirResource>[] = fhirR4SourceEntities

export { fhirPool }
