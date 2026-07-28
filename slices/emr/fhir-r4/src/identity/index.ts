// Source identity — turning the ids a remote site assigned into ids the
// on-device store can hold. `source-identity.ts` derives one id (and the
// `Identifier` that records where it came from), `relative-reference.ts` finds
// and rewrites the references that would otherwise be stranded by that
// derivation, and `adopt-source-identity.ts` applies both to a resource as the
// single operation they have to be. `fhir-server-identity.ts` adds the one
// thing a collector reading a real FHIR server needs on top: recovering the
// service base URL that names the server, from the URL a response came back
// from.
//
// A collector states only *whose* ids it is re-keying: a fixed-site collector
// a module-level `SourceIdentity`, a FHIR-server collector its prefix and the
// URL shape its entity matched. Everything after that is here.

export {
  adoptSourceIdentity,
  adoptSourceIdentityAll,
  parseWithSourceIdentity,
  type SourceKeyedResource,
} from './adopt-source-identity.ts'
export {
  fhirServerSourceIdentity,
  fhirServiceBase,
  type FhirUrlShape,
  parseWithFhirServerIdentity,
} from './fhir-server-identity.ts'
export {
  isPlainRecord,
  parseRelativeReference,
  RELATIVE_REFERENCE_PATTERN,
  type ReferenceRewrite,
  type RelativeReference,
  relativeReferencesIn,
  type RewrittenReference,
  withRewrittenReferences,
} from './relative-reference.ts'
export {
  deriveResourceId,
  derivedIdFailureAsParseError,
  DerivedIdUnavailable,
  digestInput,
  FHIR_ID_PATTERN,
  hasSourceIdentifier,
  ID_BYTES,
  sourceIdentifier,
  type SourceIdentity,
} from './source-identity.ts'
