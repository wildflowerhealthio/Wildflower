import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as PeriodSchema } from './period.ts'

const ResourceType = 'ContactPoint' as const
type ResourceType = typeof ResourceType

/** Telecommunications form for contact point. */
const SystemSchema = Schema.Union(
  Schema.Literal('phone'),
  Schema.Literal('fax'),
  Schema.Literal('email'),
  Schema.Literal('pager'),
  Schema.Literal('url'),
  Schema.Literal('sms'),
  Schema.Literal('other')
)
type System = typeof SystemSchema.Type

/** Identifies the purpose for the contact point. */
const UseSchema = Schema.Union(
  Schema.Literal('home'),
  Schema.Literal('work'),
  Schema.Literal('temp'),
  Schema.Literal('old'),
  Schema.Literal('mobile')
)
type Use = typeof UseSchema.Type

const fields = {
  system: Schema.NullOr(SystemSchema),
  value: Schema.NullOr(Schema.String),
  use: Schema.NullOr(UseSchema),
  rank: Schema.NullOr(Schema.Int),
  period: Schema.NullOr(PeriodSchema),
} as const satisfies FieldsNoContext

/**
 * Details for all kinds of technology mediated contact points for a person or organization, including telephone, email, etc.
 */
const ContactPointSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, ContactPointSchema)

export { Datatype, ResourceType, SystemSchema, UseSchema, ContactPointSchema as Schema }
export type { System, Use }
