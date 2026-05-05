import { Schema } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  StructNoContext,
  type FieldsNoContext,
} from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as CodingSchema } from './coding.ts'
import { Schema as ElementSchema } from './element.ts'

// ---------------------------------------------------------------------------
// CodeableConcept
// ---------------------------------------------------------------------------

const ResourceType = 'CodeableConcept' as const
type ResourceType = typeof ResourceType

const fields = {
  /**
   * Codes may be defined very casually in enumerations, or code lists, up to
   * very formal definitions such as SNOMED CT - see the HL7 v3 Core Principles
   * for more information.
   *
   * `Arbitrary.make(...)` caps generated arrays to length ≤ 2; FHIR allows
   * any number of codings, so production decode/encode behavior is unchanged.
   * The cap exists purely to keep property-test fan-out tractable — every
   * CodeableConcept-bearing schema (Identifier.type, Reference.identifier,
   * Patient.contact.relationship, …) inherits this generator cost.
   */
  coding: Schema.Array(CodingSchema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  /**
   * Very often the text is the same as a displayName of one of the codings.
   */
  text: Schema.NullOr(Schema.String),
} as const satisfies FieldsNoContext

/**
 * A concept that may be defined by one or more coding systems. Wraps an
 * array of Coding values plus optional free-text.
 */
const CodeableConceptSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, CodeableConceptSchema)

export { ResourceType, CodeableConceptSchema as Schema }
