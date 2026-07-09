import { Schema } from 'effect'

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

export { ReferenceSchema, IdentifierSchema, type ReferenceType, type IdentifierType }
