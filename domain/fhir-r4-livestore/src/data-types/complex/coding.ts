import { Schema } from 'effect'

import { Element } from '../base/element.ts'
import type { ElementEncoded } from '../base/element.ts'
import { Datatype } from '../datatype.ts'
import { Code } from './code.ts'

const ResourceType = 'Coding' as const

const fields = {
  /**
   * A symbol in syntax defined by the system. The symbol may be a predefined code or an expression in a syntax defined by the coding system (e.g. post-coordination).
   */
  code: Schema.UndefinedOr(Code).pipe(Schema.optionalWith({ default: () => undefined })),
  //_code?: Element | undefined;
  /**
   * A representation of the meaning of the code in the system, following the rules of the system.
   */
  display: Schema.UndefinedOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  //_display?: Element | undefined;
  /**
   * The URI may be an OID (urn:oid:...) or a UUID (urn:uuid:...).  OIDs and UUIDs SHALL be references to the HL7 OID registry. Otherwise, the URI should come from HL7's list of FHIR defined special URIs or it should reference to some definition that establishes the system clearly and unambiguously.
   */
  system: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  //_system?: Element | undefined;
  /**
   * Amongst a set of alternatives, a directly chosen code is the most appropriate starting point for new translations. There is some ambiguity about what exactly 'directly chosen' implies, and trading partner agreement may be needed to clarify the use of this element and its consequences more completely.
   */
  userSelected: Schema.UndefinedOr(Schema.Boolean).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  // _userSelected?: Element | undefined;
  /**
   * Where the terminology does not clearly define what string should be used to identify code system versions, the recommendation is to use the date (expressed in FHIR date format) on which that version was officially published as the version date.
   */
  version: Schema.UndefinedOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  // _version?: Element | undefined;
} as const satisfies Schema.Struct.Fields

const CodingElement = Element(ResourceType)

/** Encoded (wire-format) shape of a {@link Coding}. */
export interface CodingEncoded
  extends Schema.Struct.Encoded<typeof fields>, ElementEncoded<typeof ResourceType> {}

/**
 * A reference to a code defined by a terminology system. Binds a `code` to
 * a `system` URI and optional `display` text.
 */
export class Coding extends CodingElement.extend<Coding>(ResourceType)(fields) {
  static readonly ResourceType = CodingElement.ResourceType
  static readonly IdSchema = CodingElement.IdSchema
  static Datatype = Datatype('Coding', Coding)

  static makeLiteral = <C extends ConstructorParameters<typeof Coding>[0]>(params: C): Coding & C =>
    Coding.makeLiteral<C>(params)
}
