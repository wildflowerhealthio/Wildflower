import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Period from './period.ts'

const HumanNameStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    family: OrNullAsOptional(Schema.String),
    given: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: () => [] as readonly string[],
    }),
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    prefix: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: () => [] as readonly string[],
    }),
    suffix: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: () => [] as readonly string[],
    }),
    text: OrNullAsOptional(Schema.String),
    use: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('usual'),
        Schema.Literal('official'),
        Schema.Literal('temp'),
        Schema.Literal('nickname'),
        Schema.Literal('anonymous'),
        Schema.Literal('old'),
        Schema.Literal('maiden')
      )
    ),
  })
)

const HumanNameSchema: Schema.Schema<typeof HumanNameStruct.Type, FhirR4.HumanName, never> =
  HumanNameStruct

registerDatatypeSchema('HumanName', HumanNameSchema)

export { HumanNameSchema as Schema }
