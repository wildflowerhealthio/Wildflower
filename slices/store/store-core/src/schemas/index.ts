/**
 * FHIR R4 Effect Schemas shared across the package.
 *
 * Includes base types (Element, BackboneElement, Resource), complex types
 * (CodeableConcept, Identifier, Reference, etc.), primitives, special-purpose
 * types (Extension, Narrative), choice-element helpers, and the Bundle
 * response envelope.
 *
 * Each data type is re-exported as a namespace (`import * as X`) so consumers
 * can access the full surface (`X.Schema`, `X.ResourceType`,
 * helpers, etc.) through a single import.
 *
 * @packageDocumentation
 */

export { Bundle } from './bundle.ts'
export * as BackboneElement from './base/backbone-element.ts'
export * as Element from './base/element.ts'
export * as Meta from './base/meta.ts'
export * as Resource from './base/resource.ts'

export * as Address from './complex/address.ts'
export { AdministrativeGender } from './complex/administrative-gender.ts'
export * as Annotation from './complex/annotation.ts'
export * as Attachment from './complex/attachment.ts'
export { Code } from './complex/code.ts'
export * as CodeableConcept from './complex/codeable-concept.ts'
export * as Coding from './complex/coding.ts'
export * as ContactPoint from './complex/contact-point.ts'
export * as HumanName from './complex/human-name.ts'
export * as Identifier from './complex/identifier.ts'
export * as Period from './complex/period.ts'
export * as Quantity from './complex/quantity.ts'
export * as Range from './complex/range.ts'
export * as Reference from './complex/reference.ts'
export * as SimpleQuantity from './complex/simple-quantity.ts'

export * as Extension from './special-purpose/extension.ts'
export type { ExtensionType, ExtensionEncoded } from './special-purpose/extension.ts'
export * as Narrative from './special-purpose/narrative.ts'

export * from './datatype.ts'
export * as DatatypeChoice from './datatype-choice.ts'
