import { type Arbitrary, type FastCheck, Schema, pipe } from 'effect'

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
   * This element is used to indicate the type of the target of the reference.
   *
   * Per FHIR R4, `Reference.type` is typed as `uri`, but conventional values
   * are bare resource type names ("Patient", "Practitioner") that cannot be
   * parsed by the URL constructor. We therefore keep this as `string`. The
   * looser typing — together with the absence of target-type enforcement —
   * is captured under "Reference target-type enforcement" in
   * `slices/emr/fhir-r4/docs/Capability Statement.md`.
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
   *
   * Per FHIR R4, `Identifier.system` is `uri` — typically an absolute URL
   * or a `urn:` URN (e.g. `urn:oid:1.2.36.146.595.217.0.1`). Both parse via
   * the URL constructor.
   */
  system: Schema.NullOr(Schema.URL),
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

type ReferenceType = typeof ElementSchema.Type &
  Schema.Struct.Type<typeof referenceOwnFields> & {
    readonly identifier: IdentifierType | null
  }

type ReferenceEncoded = typeof ElementSchema.Encoded &
  Schema.Struct.Encoded<typeof referenceOwnFields> & {
    readonly identifier: IdentifierEncoded | null
  }

/**
 * A reference from one FHIR resource to another, by URL, type, display text,
 * and/or Identifier.
 *
 * Reference and Identifier are mutually recursive — `Reference.identifier`
 * points to an Identifier, while `Identifier.assigner` points back to a
 * Reference. `Schema.suspend` breaks this cycle at schema evaluation time.
 */
const ReferenceSchema: StructNoContext<
  typeof ElementSchema.fields &
    typeof referenceOwnFields & {
      readonly identifier: Schema.suspend<IdentifierType | null, IdentifierEncoded | null, never>
    }
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
  // Reference → Identifier → Reference is a mutual cycle. `Schema.suspend`
  // breaks it at schema-eval time, but the default arbitrary still walks
  // each recursion the regex/struct way and amplifies generation cost
  // exponentially across resources that hold many Reference fields
  // (Observation, Patient, …). Capping `assigner` to `null` on the
  // Identifier side (below) bounds depth to one Reference→Identifier hop.
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

type IdentifierType = typeof ElementSchema.Type &
  Schema.Struct.Type<typeof identifierOwnFields> & {
    readonly assigner: ReferenceType | null
  }

type IdentifierEncoded = typeof ElementSchema.Encoded &
  Schema.Struct.Encoded<typeof identifierOwnFields> & {
    readonly assigner: ReferenceEncoded | null
  }

/**
 * An identifier intended for computation — carries a `system` URI, a `value`,
 * an optional `type`, `use`, `period`, and an optional `assigner` Reference.
 */
const IdentifierSchema: StructNoContext<
  typeof ElementSchema.fields &
    typeof identifierOwnFields & {
      readonly assigner: Schema.Schema<ReferenceType | null, ReferenceEncoded | null, never>
    }
> = StructNoContext({
  ...ElementSchema.fields,
  ...identifierOwnFields,
  /**
   * The Identifier.assigner may omit the .reference element and only contain a .display element.
   *
   * Schema.suspend breaks the circular dependency between Identifier and Reference at runtime.
   * The arbitrary annotation caps `Arbitrary.make(...)` at `null` so property tests don't
   * recursively generate Reference→Identifier→Reference chains. The mutual cycle is
   * exercised explicitly by `cycles.test.ts`; everywhere else, capping keeps generation
   * tractable.
   */
  assigner: pipe(
    Schema.NullOr(Schema.suspend(() => ReferenceSchema)),
    Schema.annotations({
      arbitrary: (): Arbitrary.LazyArbitrary<null> => (fc: typeof FastCheck) => fc.constant(null),
    })
  ),
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
