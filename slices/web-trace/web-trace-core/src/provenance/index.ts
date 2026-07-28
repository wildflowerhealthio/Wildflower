/**
 * Provenance: the receipt for a FHIR resource a collector derived from a
 * response, and the two links that make it navigable.
 *
 * @remarks
 * The distinction from a recording is the whole point. A recorder claims every
 * response and stores bodies under an allowlist and a cap; a provenance capture
 * claims **only** a response an entity actually derived resources from, and
 * stores its body verbatim. Because the scope is that narrow, it needs no opt-in
 * flag — the bound on what it collects is what makes it always-on.
 *
 * @packageDocumentation
 */
export {
  type CapturedResponse,
  captureProvenance,
  makeFhirProvenanceCapture,
  type ProvenanceCapture,
  type ProvenanceHookResult,
  referenceTo,
  type ReferencableResource,
  toExchangeFields,
  withMetaSource,
} from './capture-provenance.ts'
