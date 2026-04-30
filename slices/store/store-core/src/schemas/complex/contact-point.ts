import { Schema as ES } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'
import { Schema as PeriodSchema } from './period.ts'

const ResourceType = 'ContactPoint' as const
type ResourceType = typeof ResourceType

const fields = {
  system: ES.NullOr(
    ES.Union(
      ES.Literal('phone'),
      ES.Literal('fax'),
      ES.Literal('email'),
      ES.Literal('pager'),
      ES.Literal('url'),
      ES.Literal('sms'),
      ES.Literal('other')
    )
  ),
  value: ES.NullOr(ES.String),
  use: ES.NullOr(
    ES.Union(
      ES.Literal('home'),
      ES.Literal('work'),
      ES.Literal('temp'),
      ES.Literal('old'),
      ES.Literal('mobile')
    )
  ),
  rank: ES.NullOr(ES.Int),
  period: ES.NullOr(PeriodSchema),
} as const satisfies FieldsNoContext

/**
 * Details for all kinds of technology mediated contact points for a person or organization, including telephone, email, etc.
 */
const Schema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, Schema)

export { Datatype, ResourceType, Schema }
