/**
 * FHIR R4 Effect Schemas shared across the package.
 *
 * Layout:
 * - `base/` — structural bases (`BackboneElement`, `Resource`)
 * - `datatypes/` — every FHIR data type (`Element`, `Meta`, primitives,
 *   `CodeableConcept`, `Identifier`, `Reference`, `Extension`, `Narrative`,
 *   etc.)
 * - `choice-element-set.ts` / `choice-element.ts` — choice-element (`value[x]`)
 *   field helpers
 * - `bundle.ts` — Bundle response envelope
 *
 * Each data type is re-exported as a namespace (`import * as X`) so consumers
 * can access the full surface (`X.Schema`, `X.ResourceType`,
 * helpers, etc.) through a single import.
 *
 * @packageDocumentation
 */

export { Bundle } from './bundle.ts'
export * as BackboneElement from './base/backbone-element.ts'
export * as Element from './datatypes/element.ts'
export * as Meta from './datatypes/meta.ts'
export * as Resource from './base/resource.ts'

export * as Address from './datatypes/address.ts'
export { AdministrativeGender } from './datatypes/administrative-gender.ts'
export * as Annotation from './datatypes/annotation.ts'
export * as Attachment from './datatypes/attachment.ts'
export { Code } from './datatypes/code.ts'
export * as CodeableConcept from './datatypes/codeable-concept.ts'
export * as Coding from './datatypes/coding.ts'
export * as ContactPoint from './datatypes/contact-point.ts'
export * as HumanName from './datatypes/human-name.ts'
export * as Identifier from './datatypes/identifier.ts'
export * as Period from './datatypes/period.ts'
export * as Quantity from './datatypes/quantity.ts'
export * as Range from './datatypes/range.ts'
export * as Ratio from './datatypes/ratio.ts'
export * as Reference from './datatypes/reference.ts'
export * as SampledData from './datatypes/sampled-data.ts'
export * as SimpleQuantity from './datatypes/simple-quantity.ts'
export * as Timing from './datatypes/timing.ts'

export * as Extension from './datatypes/extension.ts'
export type { ExtensionType, ExtensionEncoded } from './datatypes/extension.ts'
export * as Narrative from './datatypes/narrative.ts'

export * as Datatype from './datatype.ts'
export * as ChoiceElementSet from './choice-element-set.ts'
