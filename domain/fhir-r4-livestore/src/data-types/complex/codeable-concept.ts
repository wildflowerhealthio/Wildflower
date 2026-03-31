import { Schema } from 'effect'

import { Element } from '../base/element.ts'
import type { ElementEncoded } from '../base/element.ts'
import { Datatype } from '../datatype.ts'
import { Coding } from './coding.ts'
import type { CodingEncoded } from './coding.ts'

const ResourceType = 'CodeableConcept'
type ResourceType = typeof ResourceType

const fields = {
  /**
   * Codes may be defined very casually in enumerations, or code lists, up to
   * very formal definitions such as SNOMED CT - see the HL7 v3 Core Principles
   * for more information.  Ordering of codings is undefined and SHALL NOT be
   * used to infer meaning. Generally, at most only one of the coding values
   * will be labeled as UserSelected = true.
   */
  coding: Schema.Array(Schema.suspend((): Schema.Schema<Coding, CodingEncoded> => Coding)).pipe(
    Schema.optionalWith({ default: () => [] })
  ),
  /**
   * Very often the text is the same as a displayName of one of the codings.
   */
  text: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  // _text?: Element | undefined;
} as const

/** Encoded (wire-format) shape of a {@link CodeableConcept}. */
interface CodeableConceptEncoded
  extends Schema.Struct.Encoded<typeof fields>, ElementEncoded<ResourceType> {}

const CodeableConceptElement = Element<ResourceType>(ResourceType)

/**
 * A concept that may be defined by one or more coding systems. Wraps an
 * array of {@link Coding} values plus optional free-text.
 */
class CodeableConcept extends CodeableConceptElement.extend<CodeableConcept>(ResourceType)(fields) {
  static readonly ResourceType = CodeableConceptElement.ResourceType
  static readonly IdSchema = CodeableConceptElement.IdSchema
  /** {@link Datatype} wrapper for use in {@link DatatypeChoice} value\[x\] unions. */
  static Datatype = Datatype('CodeableConcept', CodeableConcept)
}

export { CodeableConcept, type CodeableConceptEncoded, ResourceType }
