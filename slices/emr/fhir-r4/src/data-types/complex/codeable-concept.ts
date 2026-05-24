import { Schema } from 'effect'

import type { CodeableConcept as StoreCodeableConcept } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Coding from './coding.ts'

const CodeableConceptSchema: Schema.Schema<
  typeof StoreCodeableConcept.Schema.Type,
  FhirR4.CodeableConcept,
  never
> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    coding: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.suspend(() => Coding.Schema))), {
      default: (): readonly (typeof Coding.Schema.Type)[] => [],
    }),
    text: OrNullAsOptional(Schema.String),
  })
)

registerDatatypeSchema('CodeableConcept', CodeableConceptSchema)

export { CodeableConceptSchema as Schema }
