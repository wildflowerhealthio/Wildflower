import { Schema } from 'effect'

import type { ContactPoint as StoreContactPoint } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'
import * as Period from './period.ts'

const ContactPointSchema: Schema.Schema<
  typeof StoreContactPoint.Schema.Type,
  FhirR4.ContactPoint,
  never
> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    period: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    rank: OrNullAsOptional(Schema.Int),
    system: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('phone'),
        Schema.Literal('fax'),
        Schema.Literal('email'),
        Schema.Literal('pager'),
        Schema.Literal('url'),
        Schema.Literal('sms'),
        Schema.Literal('other')
      )
    ),
    use: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('home'),
        Schema.Literal('work'),
        Schema.Literal('temp'),
        Schema.Literal('old'),
        Schema.Literal('mobile')
      )
    ),
    value: OrNullAsOptional(Schema.String),
  })
)

export { ContactPointSchema as Schema }
