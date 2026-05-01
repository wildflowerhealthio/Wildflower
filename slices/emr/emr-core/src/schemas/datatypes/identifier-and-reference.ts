import { Schema } from 'effect'

import { StructNoContext } from 'kitchen-sink/schema'
import { Schema as CodeableConceptSchema } from './codeable-concept.ts'
import { Schema as ElementSchema } from './element.ts'
import { Schema as PeriodSchema } from './period.ts'

/**
 * Circular dependency note:
 * Reference and Identifier have a mutual dependency:
 * - Reference can contain an optional Identifier
 * - Identifier can contain an optional Reference (via the assigner field)
 *
 * This file owns the two mutually recursive `Schema.Struct` definitions so
 * that no cross-file ESM cycle is introduced. The neighbour files
 * `./reference.ts` and `./identifier.ts` are thin facades that re-export
 * from here and add helpers / module-scope functions.
 */

const ReferenceResourceType = 'Reference' as const
type ReferenceResourceType = typeof ReferenceResourceType

const IdentifierResourceType = 'Identifier' as const
type IdentifierResourceType = typeof IdentifierResourceType

/** FHIR R4 value set for `Identifier.use`: usual | official | temp | secondary | old. */
const IdentifierUse = Schema.Enums({
  official: 'official',
  old: 'old',
  secondary: 'secondary',
  temp: 'temp',
  usual: 'usual',
} as const)

const referenceOwnFields = {
  /**
   * This is generally not the same as the Resource.text of the referenced resource.  The purpose is to identify what's being referenced, not to fully describe it.
   */
  display: Schema.NullOr(Schema.String),
  /**
   * Using absolute URLs provides a stable scalable approach suitable for a cloud/web context, while using relative/logical references provides a flexible approach suitable for use when trading across closed eco-system boundariSchema.   Absolute URLs do not need to point to a FHIR RESTful server, though this is the preferred approach. If the URL conforms to the structure "/[type]/[id]" then it should be assumed that the reference is to a FHIR RESTful server.
   */
  reference: Schema.NullOr(Schema.String),
  /**
   * This element is used to indicate the type of  the target of the reference. This may be used which ever of the other elements are populated (or not). In some cases, the type of the target may be determined by inspection of the reference (e.g. a RESTful URL) or by resolving the target of the reference; if both the type and a reference is provided, the reference SHALL resolve to a resource of the same type as that specified.
   */
  type: Schema.NullOr(Schema.String),
} as const satisfies Schema.Struct.Fields

const identifierOwnFields = {
  /**
   * Time period during which identifier is/was valid for use.
   */
  period: Schema.NullOr(PeriodSchema),
  /**
   * Identifier.system is always case sensitive.
   */
  system: Schema.NullOr(Schema.String),
  /**
   * This element deals only with general categories of identifiers.  It SHOULD not be used for codes that correspond 1..1 with the Identifier.system.
   */
  type: Schema.NullOr(CodeableConceptSchema),
  /**
   * Applications can assume that an identifier is permanent unless it explicitly says that it is temporary.
   */
  use: Schema.NullOr(IdentifierUse),
  /**
   * If the value is a full URI, then the system SHALL be urn:ietf:rfc:3986.
   */
  value: Schema.NullOr(Schema.String),
} as const satisfies Schema.Struct.Fields

/**
 * A reference from one FHIR resource to another, by URL, type, display text,
 * and/or Identifier.
 *
 * Reference and Identifier are mutually recursive — `Reference.identifier`
 * points to an Identifier, while `Identifier.assigner` points back to a
 * Reference. `Schema.suspend` breaks this cycle at schema evaluation time.
 */
const ReferenceSchema: Schema.Schema<
  Schema.Schema.Type<typeof ElementSchema> &
    Schema.Struct.Type<typeof referenceOwnFields> & {
      readonly identifier: null | Schema.Schema.Type<typeof IdentifierSchema>
    },
  Schema.Schema.Encoded<typeof ElementSchema> &
    Schema.Struct.Encoded<typeof referenceOwnFields> & {
      readonly identifier: Schema.Schema.Encoded<typeof IdentifierSchema> | null
    },
  never
> = StructNoContext({
  ...ElementSchema.fields,
  ...referenceOwnFields,
  /**
   * When both an identifier and a literal reference are provided, the literal reference is preferred.
   *
   * Schema.suspend breaks the circular dependency between Reference and Identifier at runtime.
   */
  identifier: Schema.NullOr(Schema.suspend(() => IdentifierSchema)),
}).annotations({
  jsonSchema: {
    description: 'A reference from one FHIR resource to another',
    type: 'object',
    properties: {
      id: { type: 'string' },
      extension: {
        type: 'array',
        items: { $ref: 'Extension' },
      },
      display: { type: 'string' },
      reference: { type: 'string' },
      type: { type: 'string' },
      identifier: { $ref: 'Identifier' },
    },
    required: ['resourceType'],
  },
})

/**
 * An identifier intended for computation — carries a `system` URI, a `value`,
 * an optional `type`, `use`, `period`, and an optional `assigner` Reference.
 */
const IdentifierSchema: Schema.Schema<
  Schema.Schema.Type<typeof ElementSchema> &
    Schema.Struct.Type<typeof identifierOwnFields> & {
      readonly assigner: null | Schema.Schema.Type<typeof ReferenceSchema>
    },
  Schema.Schema.Encoded<typeof ElementSchema> &
    Schema.Struct.Encoded<typeof identifierOwnFields> & {
      readonly assigner: null | Schema.Schema.Encoded<typeof ReferenceSchema>
    },
  never
> = StructNoContext({
  ...ElementSchema.fields,
  ...identifierOwnFields,
  /**
   * The Identifier.assigner may omit the .reference element and only contain a .display element.
   *
   * Schema.suspend breaks the circular dependency between Identifier and Reference at runtime.
   */
  assigner: Schema.NullOr(Schema.suspend(() => ReferenceSchema)),
}).annotations({
  jsonSchema: {
    description: 'An identifier intended for computation',
    type: 'object',
    properties: {
      id: { type: 'string' },
      extension: {
        type: 'array',
        items: { $ref: 'Extension' },
      },
      period: { $ref: 'Period' },
      system: { type: 'string' },
      type: { $ref: 'CodeableConcept' },
      use: {
        type: 'string',
        enum: ['official', 'old', 'secondary', 'temp', 'usual'],
      },
      value: { type: 'string' },
      assigner: { $ref: 'Reference' },
    },
    required: ['resourceType'],
  },
})

export {
  IdentifierResourceType,
  IdentifierSchema,
  IdentifierUse,
  ReferenceResourceType,
  ReferenceSchema,
}
