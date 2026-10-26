import { Equivalence, Option, pipe, Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as FhirString from '../base/fhir-string.ts'
import { narrowFields } from '../narrow-fields.ts'
import * as CodeableConcept from './codeable-concept.ts'
import * as Period from './period.ts'

// Reference and Identifier are mutually recursive (`Reference.identifier` /
// `Identifier.assigner`), so both decoded types are written out explicitly —
// TypeScript cannot infer types for mutually referential schema constants.

interface ReferenceType extends Schema.Struct.Type<typeof Element.fields> {
  readonly display: string | null
  readonly identifier: IdentifierType | null
  readonly reference: string | null
  readonly type: string | null
}

interface IdentifierType extends Schema.Struct.Type<typeof Element.fields> {
  readonly assigner: ReferenceType | null
  readonly period: typeof Period.Schema.Type | null
  readonly system: URL | null
  readonly type: typeof CodeableConcept.Schema.Type | null
  readonly use: 'usual' | 'official' | 'temp' | 'secondary' | 'old' | null
  readonly value: string | null
}

const ReferenceSchema: Schema.Schema<ReferenceType, FhirR4.Reference, never> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    display: FhirString.Optional,
    identifier: OrNullAsOptional(Schema.suspend(() => IdentifierSchema)),
    reference: FhirString.Optional,
    type: OrNullAsOptional(Schema.String),
  })
)

const IdentifierSchema: Schema.Schema<IdentifierType, FhirR4.Identifier, never> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    assigner: OrNullAsOptional(Schema.suspend(() => ReferenceSchema)),
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    system: OrNullAsOptional(Schema.URL),
    type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    use: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('usual'),
        Schema.Literal('official'),
        Schema.Literal('temp'),
        Schema.Literal('secondary'),
        Schema.Literal('old')
      )
    ),
    value: FhirString.Optional,
  })
)

registerDatatypeSchema('Identifier', IdentifierSchema)
registerDatatypeSchema('Reference', ReferenceSchema)

/**
 * A decoded `Identifier` that names something in particular: one carrying
 * both a `system` and a non-empty `value`, the value qualified by the
 * namespace it is drawn from. An identifier missing either names nothing, so
 * anything that links records by identifier keeps only these.
 */
const QualifiedIdentifierSchema = narrowFields(Schema.typeSchema(IdentifierSchema), {
  system: Schema.instanceOf(URL),
  value: Schema.NonEmptyString,
})

type QualifiedIdentifierType = typeof QualifiedIdentifierSchema.Type

/** Whether a decoded `Identifier` is a {@link QualifiedIdentifierSchema}. */
const isQualifiedIdentifier: (identifier: IdentifierType) => identifier is QualifiedIdentifierType =
  Schema.is(QualifiedIdentifierSchema)

/** An all-empty `Reference`; a placeholder for required-reference slots. */
const emptyReference: ReferenceType = {
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: null,
  type: null,
}

/**
 * A `Reference.reference` naming a resource carried in the referencing
 * resource's own `contained`: `#` followed by that resource's `id`.
 *
 * @remarks
 * The only literal reference that resolves without leaving the resource. Any
 * other value names something outside it (a relative `Type/id`, an absolute
 * URL), which a writer re-pointing references inside one resource must leave
 * alone.
 */
const FragmentReference = Schema.TemplateLiteralParser('#', Schema.NonEmptyString)

const decodeFragmentReference = Schema.decodeUnknownOption(FragmentReference)

/** The `id` of the contained resource a `#id` reference names, or `None` for any other reference. */
const fragmentIdOf = (reference: string): Option.Option<string> =>
  Option.map(decodeFragmentReference(reference), ([, id]) => id)

/** The `#id` reference to the contained resource with `id`. */
const fragmentReferenceTo = (id: string): string => `#${id}`

/**
 * A relative literal reference to the resource of `resourceType` stored under
 * `id` — `Patient/p-1`, `ServiceRequest/sr-2`.
 */
const referenceTo = (target: {
  readonly resourceType: string
  readonly id: string
}): ReferenceType => ({
  ...emptyReference,
  reference: `${target.resourceType}/${target.id}`,
})

/**
 * The id a relative literal reference to `resourceType` names — `sr-2` from
 * `ServiceRequest/sr-2` — or `None` for a reference to another type, an
 * empty id, or no literal reference at all.
 */
const referencedIdOf = (reference: ReferenceType, resourceType: string): Option.Option<string> =>
  pipe(
    Option.fromNullable(reference.reference),
    Option.filter((literal) => literal.startsWith(`${resourceType}/`)),
    Option.map((literal) => literal.slice(resourceType.length + 1)),
    Option.filter((id) => id.length > 0)
  )

/**
 * Whether two identifiers name the same thing: the same `system` and the same
 * `value`, whatever else (`use`, `period`, `assigner`) either carries.
 *
 * @remarks
 * A missing `system` or `value` compares equal to another missing one, as an
 * equivalence must hold every identifier alike to itself. Two such identifiers
 * name nothing in common, so a caller linking records by identifier keeps only
 * those carrying both before comparing.
 */
const identifierEquivalence: Equivalence.Equivalence<IdentifierType> = Equivalence.make(
  (left, right) =>
    (left.system?.href ?? null) === (right.system?.href ?? null) && left.value === right.value
)

export {
  ReferenceSchema,
  referenceTo,
  referencedIdOf,
  IdentifierSchema,
  identifierEquivalence,
  isQualifiedIdentifier,
  QualifiedIdentifierSchema,
  emptyReference,
  fragmentIdOf,
  fragmentReferenceTo,
  type ReferenceType,
  type IdentifierType,
  type QualifiedIdentifierType,
}
