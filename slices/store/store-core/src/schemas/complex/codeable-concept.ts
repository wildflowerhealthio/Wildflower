import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as CodingSchema } from './coding.ts'

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
   */
  coding: Schema.Array(CodingSchema),
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

/** {@link makeDatatype} wrapper for use in DatatypeChoice value[x] unions. */
const Datatype = makeDatatype(ResourceType, CodeableConceptSchema)

export { Datatype, ResourceType, CodeableConceptSchema as Schema }
