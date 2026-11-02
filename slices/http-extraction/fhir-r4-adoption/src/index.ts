/**
 * The FHIR R4 side of extraction: how a resource decoded from a source becomes
 * the device's own, keyed under a local id derived from the system its source
 * id belongs to, its type and that id, with an id whether or not the source
 * gave it one.
 *
 * @packageDocumentation
 */
export {
  adoptResource,
  adoptWithSourceId,
  adoptedReferenceOf,
  originalIdOf,
  type ResourceWithSourceId,
} from './adopt-resource.ts'
export { adoptUnderRecognizedRoot } from './adopt-under-recognized-root.ts'
export * as DecodedId from './decoded-id.ts'
export * as FhirBaseUrl from './fhir-base-url.ts'
export * as SystemFamily from './system-family.ts'
