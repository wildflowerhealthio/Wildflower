import { Schema } from 'effect'

import type { Identifier as StoreIdentifier, Reference as StoreReference } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as CodeableConcept from './codeable-concept.ts'
import * as Period from './period.ts'

const ReferenceSchema: Schema.Schema<typeof StoreReference.Schema.Type, FhirR4.Reference, never> =
  mutableEncoded(
    StructNoContext({
      ...Element.fields,
      display: OrNullAsOptional(Schema.String),
      identifier: OrNullAsOptional(Schema.suspend(() => IdentifierSchema)),
      reference: OrNullAsOptional(Schema.String),
      type: OrNullAsOptional(Schema.String),
    })
  )

const IdentifierSchema: Schema.Schema<
  typeof StoreIdentifier.Schema.Type,
  FhirR4.Identifier,
  never
> = mutableEncoded(
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

export { ReferenceSchema, IdentifierSchema }
