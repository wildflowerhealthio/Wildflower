/**
 * The FHIR R4 side of extraction: how a resource decoded from a source becomes
 * the device's own, keyed under a local id derived from the source's identity,
 * with an id whether or not the source gave it one.
 *
 * @packageDocumentation
 */
export {
  adoptResource,
  adoptedReferenceOf,
  originalIdOf,
  type SourceIdentity,
} from './adopt-resource.ts'
export { adoptUnderRecognizedRoot } from './adopt-under-recognized-root.ts'
export * as DecodedId from './decoded-id.ts'
