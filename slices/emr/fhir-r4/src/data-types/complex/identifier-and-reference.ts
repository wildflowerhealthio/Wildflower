import { Option, Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
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
    display: OrNullAsOptional(Schema.String),
    identifier: OrNullAsOptional(Schema.suspend(() => IdentifierSchema)),
    reference: OrNullAsOptional(Schema.String),
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
    value: OrNullAsOptional(Schema.String),
  })
)

registerDatatypeSchema('Identifier', IdentifierSchema)
registerDatatypeSchema('Reference', ReferenceSchema)

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

export {
  ReferenceSchema,
  IdentifierSchema,
  emptyReference,
  fragmentIdOf,
  fragmentReferenceTo,
  type ReferenceType,
  type IdentifierType,
}
