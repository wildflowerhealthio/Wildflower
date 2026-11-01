/**
 * The FHIR R4 side of extraction: how a resource decoded from a source becomes
 * the device's own, keyed under a local id derived from its id space, its type
 * and its source id, with an id whether or not the source gave it one.
 *
 * @packageDocumentation
 */
export {
  adoptInIdSpace,
  adoptResource,
  adoptedReferenceOf,
  originalIdOf,
  type ResourceWithSourceId,
  type SourceIdentity,
} from './adopt-resource.ts'
export { adoptUnderRecognizedRoot } from './adopt-under-recognized-root.ts'
export * as DecodedId from './decoded-id.ts'
export * as IdSpace from './id-space.ts'
