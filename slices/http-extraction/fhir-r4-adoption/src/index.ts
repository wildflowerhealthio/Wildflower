/**
 * The FHIR R4 side of extraction: a resource a source decoded, detached from
 * that source (no id, keyed by its first identifier, its references logical),
 * whether a decoder writes it so or detaches a server's record, and a
 * detached resource adopted into the device's store under an id derived from
 * its key.
 *
 * @packageDocumentation
 */
export {
  adopt,
  adoptedReferenceOf,
  detach,
  originalIdOf,
  randomResourceId,
} from './adopt-resource.ts'
export type { Adoption } from './adopt-resource.ts'
export * as DetachedResource from './detached-resource.ts'
