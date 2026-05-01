import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as PeriodSchema } from './period.ts'

const ResourceType = 'HumanName' as const
type ResourceType = typeof ResourceType

/** Identifies the purpose for this name. */
const UseSchema = Schema.Union(
  Schema.Literal('usual'),
  Schema.Literal('official'),
  Schema.Literal('temp'),
  Schema.Literal('nickname'),
  Schema.Literal('anonymous'),
  Schema.Literal('old'),
  Schema.Literal('maiden')
)
type Use = typeof UseSchema.Type

const fields = {
  use: Schema.NullOr(UseSchema),
  text: Schema.NullOr(Schema.String),
  family: Schema.NullOr(Schema.String),
  given: Schema.Array(Schema.String),
  prefix: Schema.Array(Schema.String),
  suffix: Schema.Array(Schema.String),
  period: Schema.NullOr(PeriodSchema),
} as const satisfies FieldsNoContext

/**
 * A human's name with the ability to identify parts and usage.
 */
const HumanNameSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, HumanNameSchema)

export { Datatype, ResourceType, UseSchema, HumanNameSchema as Schema }
export type { Use }
