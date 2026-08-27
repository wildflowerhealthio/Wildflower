/**
 * The FHIR R4 source: how FHIR R4 traffic decodes into resources, and the
 * assembled source built from that decode.
 *
 * @remarks
 * Two layers, all exported from here:
 *
 * - the three response kinds (`PatientResponseKind`, `ObservationResponseKind`,
 *   `ObservationListResponseKind`) and the `fhirR4ResponseKinds` tuple — the
 *   **single definition** of how FHIR R4 traffic decodes (recognition + root
 *   fused on each kind's `tryRecognize`), consumed by this package's source
 *   surface and by the live scraping plan in `fhir-r4-client-collector` (which
 *   keys resources under its configured root);
 * - the source response kinds (`fhirR4SourceEntities`) — the same tuple wrapped
 *   with `adoptUnderRecognizedRoot`, so each resource is keyed under the root
 *   of the URL it arrived on. This is what `har-importer-core`'s `fhirPool`
 *   registers.
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
export { fhirR4SourceEntities } from './source-entities.ts'
