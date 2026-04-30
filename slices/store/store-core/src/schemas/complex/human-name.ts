import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as PeriodSchema } from './period.ts'

const ResourceType = 'HumanName' as const
type ResourceType = typeof ResourceType

const fields = {
  use: ES.NullOr(
    ES.Union(
      ES.Literal('usual'),
      ES.Literal('official'),
      ES.Literal('temp'),
      ES.Literal('nickname'),
      ES.Literal('anonymous'),
      ES.Literal('old'),
      ES.Literal('maiden')
    )
  ),
  text: ES.NullOr(ES.String),
  family: ES.NullOr(ES.String),
  given: ES.Array(ES.String),
  prefix: ES.Array(ES.String),
  suffix: ES.Array(ES.String),
  period: ES.NullOr(PeriodSchema),
} as const satisfies FieldsNoContext

/**
 * A human's name with the ability to identify parts and usage.
 */
const Schema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, ResourceType, Schema }
