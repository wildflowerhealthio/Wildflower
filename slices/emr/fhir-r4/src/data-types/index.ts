// FHIR R4 data types — wire-format Effect schemas for every datatype the
// slice models. Each export is a namespace whose `Schema` member is the
// adapter-side schema used to encode/decode FHIR R4 JSON. Add a new entry
// here whenever a new datatype file lands.

export { withMandatoryId } from './with-mandatory-id.ts'

// Base
export * as BackboneElement from './base/backbone-element.ts'
export { Code } from './base/code.ts'
export * as ChoiceElementSet from './base/choice-element-set.ts'
export * as Datatype from './base/datatype.ts'
export * as DomainResource from './base/domain-resource.ts'
export * as Element from './base/element.ts'
export * as Meta from './base/meta.ts'
export * as Resource from './base/resource.ts'
export { choiceElementSetPassthroughFields } from './base/choice-element-passthrough-fields.ts'

// Complex
export * as Address from './complex/address.ts'
export { AdministrativeGender } from './complex/administrative-gender.ts'
export * as Annotation from './complex/annotation.ts'
export * as Attachment from './complex/attachment.ts'
export * as CodeableConcept from './complex/codeable-concept.ts'
export * as Coding from './complex/coding.ts'
export * as ContactPoint from './complex/contact-point.ts'
export * as Dosage from './complex/dosage.ts'
export * as Duration from './complex/duration.ts'
export * as HumanName from './complex/human-name.ts'
export * as IdentifierAndReference from './complex/identifier-and-reference.ts'
export * as Period from './complex/period.ts'
export * as Quantity from './complex/quantity.ts'
export * as Range from './complex/range.ts'
export * as Ratio from './complex/ratio.ts'
export * as SampledData from './complex/sampled-data.ts'
export * as SimpleQuantity from './complex/simple-quantity.ts'
export * as Timing from './complex/timing.ts'

// Special purpose
export * as Extension from './special-purpose/extension.ts'
export * as Narrative from './special-purpose/narrative.ts'

// Resources
export * as Bundle from './resources/bundle.ts'

// Named decoded interfaces, re-exported at the top level so downstream packages
// that build schemas from these datatypes (e.g. `fhir-stu3-as-r4`) can name them in
// generated declarations. Without a top-level export path, `tsgo`'s `.d.ts`
// emit can't reference these interfaces from an inferred type and fails with
// TS2883 ("cannot be named without a reference to '<Name>'").
export type { Type as ExtensionType } from './special-purpose/extension.ts'
export type { ReferenceType, IdentifierType } from './complex/identifier-and-reference.ts'
export type { BundleValue } from './resources/bundle.ts'
