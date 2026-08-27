/**
 * The FHIR R4 source: how FHIR R4 traffic decodes into resources, and the
 * assembled source built from that decode.
 *
 * @remarks
 * Three layers, all exported from here:
 *
 * - the three response kinds (`PatientResponseKind`, `ObservationResponseKind`,
 *   `ObservationListResponseKind`) and the `fhirR4ResponseKinds` tuple — the
 *   **single definition** of how FHIR R4 traffic decodes, consumed by this
 *   package's source surface and by the live scraping plan in
 *   `fhir-r4-client-collector` (which keys resources under its configured
 *   root);
 * - the per-URL root primitive (`fhirRootOf`) and the source response kinds
 *   (`fhirR4SourceEntities`, keying each resource under the root of the URL it
 *   arrived on);
 * - `fhirR4Source`, the whole source as one `Source.Source` value a
 *   consumer registers — its own `claims`/`specificity` recognizing FHIR R4
 *   traffic, `fhirR4SourceEntities` as its `responseKinds`, and `fhirRootOf`
 *   as its `rootOf`.
 *
 * The collector's own concerns — config schema, scraping plan, config form,
 * descriptor — stay in `fhir-r4-client-collector`, which depends on this
 * package. No DOM, no `fs`, no React.
 *
 * @packageDocumentation
 */
export { PatientResponseKind } from './response-kinds/patient-response-kind.ts'
export { ObservationResponseKind } from './response-kinds/observation-response-kind.ts'
export { ObservationListResponseKind } from './response-kinds/observation-list-response-kind.ts'
export { extractJson } from './extract-json.ts'
export { fhirR4ResponseKinds } from './plan-entities.ts'
export { fhirRootOf } from './root.ts'
export { fhirR4SourceEntities } from './source-entities.ts'
export { fhirR4Source } from './source.ts'
