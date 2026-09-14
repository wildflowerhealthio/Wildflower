import { Schema } from 'effect'

import * as DateSearchParam from '../search/date-search-param.ts'
import { IntentSchema, StatusSchema } from './service-request.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  intent: Schema.optional(IntentSchema),
  code: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  authored: Schema.optional(DateSearchParam.Schema),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
