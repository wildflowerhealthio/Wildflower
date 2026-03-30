import { Effect, Schema } from 'effect'
import type { ParseError } from 'effect/ParseResult'

import { ExternalAssertionError } from 'ontology/errors'

import { Element } from '../base/index.ts'
import type { ElementEncoded } from '../base/index.ts'
import { CodeableConcept } from './codeable-concept.ts'
import type { CodeableConceptEncoded } from './codeable-concept.ts'
import { Period } from './period.ts'

/**
 * Circular dependency note:
 * Reference and Identifier have a mutual dependency:
 * - Reference can contain an optional Identifier
 * - Identifier can contain an optional Reference (via the assigner field)
 *
 * This circular reference is intentional and reflects the FHIR specification.
 * Schema.suspend() is used in the schema definitions below to break the circular
 * reference at runtime by lazily evaluating the schema when needed.
 */

const ReferenceKey = 'Reference'
type ReferenceKey = typeof ReferenceKey

const referenceFields = {
  /**
   * This is generally not the same as the Resource.text of the referenced resource.  The purpose is to identify what's being referenced, not to fully describe it.
   */
  display: Schema.optional(Schema.String),
  // _display?: Element | undefined;
  /**
   * Using absolute URLs provides a stable scalable approach suitable for a cloud/web context, while using relative/logical references provides a flexible approach suitable for use when trading across closed eco-system boundaries.   Absolute URLs do not need to point to a FHIR RESTful server, though this is the preferred approach. If the URL conforms to the structure "/[type]/[id]" then it should be assumed that the reference is to a FHIR RESTful server.
   */
  reference: Schema.optional(Schema.String),
  // _reference?: Element | undefined;
  /**
   * This element is used to indicate the type of  the target of the reference. This may be used which ever of the other elements are populated (or not). In some cases, the type of the target may be determined by inspection of the reference (e.g. a RESTful URL) or by resolving the target of the reference; if both the type and a reference is provided, the reference SHALL resolve to a resource of the same type as that specified.
   */
  type: Schema.optional(Schema.String),
  // _type?: Element | undefined;
} as const satisfies Schema.Struct.Fields

interface ReferenceType extends Schema.Struct.Type<typeof referenceFields>, Element<ReferenceKey> {
  identifier?: IdentifierType
}

/** Encoded (wire-format) shape of a {@link Reference}. */
interface ReferenceEncoded
  extends Schema.Struct.Encoded<typeof referenceFields>, ElementEncoded<ReferenceKey> {
  identifier?: IdentifierEncoded
}

const ReferenceElement = Element(ReferenceKey)

/**
 * A reference from one FHIR resource to another, by URL, type, display text,
 * and/or {@link Identifier}.
 *
 * @remarks
 * Reference and Identifier are mutually recursive — `Reference.identifier`
 * points to an Identifier, while `Identifier.assigner` points back to a
 * Reference. `Schema.suspend` breaks this cycle at schema evaluation time.
 * Both types are co-located in this file to avoid cross-file circular imports.
 */
class Reference extends ReferenceElement.extend<Reference>(ReferenceKey)({
  ...referenceFields,
  /**
   * When an identifier is provided in place of a reference, any system processing the reference will only be able to resolve the identifier to a reference if it understands the business context in which the identifier is used. Sometimes this is global (e.g. a national identifier) but often it is not. For this reason, none of the useful mechanisms described for working with references (e.g. chaining, includes) are possible, nor should servers be expected to be able resolve the reference. Servers may accept an identifier based reference untouched, resolve it, and/or reject it - see CapabilityStatement.rest.resource.referencePolicy.
   * When both an identifier and a literal reference are provided, the literal reference is preferred. Applications processing the resource are allowed - but not required - to check that the identifier matches the literal reference
   * Applications converting a logical reference to a literal reference may choose to leave the logical reference present, or remove it.
   * Reference is intended to point to a structure that can potentially be expressed as a FHIR resource, though there is no need for it to exist as an actual FHIR resource instance - except in as much as an application wishes to actual find the target of the reference. The content referred to be the identifier must meet the logical constraints implied by any limitations on what resource types are permitted for the reference.  For example, it would not be legitimate to send the identifier for a drug prescription if the type were Reference(Observation|DiagnosticReport).  One of the use-cases for Reference.identifier is the situation where no FHIR representation exists (where the type is Reference (Any).
   *
   * Note: Schema.suspend is used here to break the circular dependency between
   * Reference and Identifier at runtime.
   */
  identifier: Schema.optional(
    Schema.suspend((): Schema.Schema<Identifier, IdentifierEncoded> => Identifier)
  ),
}) {
  static readonly ResourceType = ReferenceElement.ResourceType
  static readonly IdSchema = ReferenceElement.IdSchema
  /**
   * Decodes this reference's URL string into a branded resource URL, failing
   * if the `type` doesn't match or `reference` is absent.
   *
   * @typeParam TUrl - The branded URL type to decode into
   * @param t - Object with `ResourceType` and `IdSchema` (typically a resource class)
   */
  asResourceUrl(): Effect.Effect<string, ExternalAssertionError | ParseError> {
    if (this.reference === undefined) {
      return Effect.fail(
        new ExternalAssertionError({
          cause: this,
          expected: '`reference` to be set on Reference',
        })
      )
    }

    return Effect.succeed(this.reference)
  }

  /**
   * Creates a Reference pointing to a resource, or `undefined` if the
   * resource has no URL. Sets `type` from `resourceType`.
   */
  static fromResource(
    resource: { meta: { source?: string | undefined }; resourceType: string },
    display: string | undefined = undefined
  ): Reference | undefined {
    if (!(resource && resource.meta.source)) {
      return undefined
    }
    return new Reference({
      display,
      reference: resource.meta.source,
      type: resource.resourceType,
    })
  }
}

const IdentifierKey = 'Identifier'
type IdentifierKey = typeof IdentifierKey

/** FHIR R4 value set for `Identifier.use`: usual | official | temp | secondary | old. */
const IdentifierUse = Schema.Enums({
  official: 'official',
  old: 'old',
  secondary: 'secondary',
  temp: 'temp',
  usual: 'usual',
} as const)

const identifierFields = {
  /**
   * Time period during which identifier is/was valid for use.
   */
  period: Schema.optional(Schema.suspend(() => Period)), //Period | undefined;
  /**
   * Identifier.system is always case sensitive.
   */
  system: Schema.optional(Schema.String),
  // _system?: Element | undefined;
  /**
   * This element deals only with general categories of identifiers.  It SHOULD not be used for codes that correspond 1..1 with the Identifier.system. Some identifiers may fall into multiple categories due to common usage.   Where the system is known, a type is unnecessary because the type is always part of the system definition. However systems often need to handle identifiers where the system is not known. There is not a 1:1 relationship between type and system, since many different systems have the same type.
   */
  type: Schema.optional(
    Schema.suspend(
      (): Schema.Schema<typeof CodeableConcept.Type, CodeableConceptEncoded> => CodeableConcept
    )
  ),
  /**
   * Applications can assume that an identifier is permanent unless it explicitly says that it is temporary.
   */
  use: Schema.optional(IdentifierUse),
  //_use?: Element | undefined;
  /**
   * If the value is a full URI, then the system SHALL be urn:ietf:rfc:3986.  The value's primary purpose is computational mapping.  As a result, it may be normalized for comparison purposes (e.g. removing non-significant whitespace, dashes, etc.)  A value formatted for human display can be conveyed using the [Rendered Value extension](extension-rendered-value.html). Identifier.value is to be treated as case sensitive unless knowledge of the Identifier.system allows the processer to be confident that non-case-sensitive processing is safe.
   */
  value: Schema.optional(Schema.String),
  // _value?: Element | undefined;
} as const satisfies Schema.Struct.Fields

interface IdentifierType
  extends Schema.Struct.Type<typeof identifierFields>, Element<IdentifierKey> {
  assigner?: ReferenceType
}

/** Encoded (wire-format) shape of an {@link Identifier}. */
interface IdentifierEncoded
  extends Schema.Struct.Encoded<typeof identifierFields>, ElementEncoded<IdentifierKey> {
  assigner?: ReferenceEncoded
}

const IdentifierElement = Element(IdentifierKey)

/**
 * An identifier intended for computation — carries a `system` URI, a `value`,
 * an optional `type`, `use`, `period`, and an optional `assigner`
 * {@link Reference}.
 *
 * @see {@link Reference} for the mutual-recursion notes
 */
class Identifier extends IdentifierElement.extend<Identifier>(IdentifierKey)({
  ...identifierFields,
  /**
   * The Identifier.assigner may omit the .reference element and only contain a .display element reflecting the name or other textual information about the assigning organization.
   *
   * Note: Schema.suspend is used here to break the circular dependency between
   * Identifier and Reference at runtime.
   */
  assigner: Schema.optional(
    Schema.suspend((): Schema.Schema<Reference, ReferenceEncoded> => Reference)
  ),
}) {
  static readonly ResourceType = IdentifierElement.ResourceType
  static readonly IdSchema = IdentifierElement.IdSchema
}

export type { ReferenceEncoded, IdentifierEncoded }
export { Reference, Identifier, IdentifierUse }
