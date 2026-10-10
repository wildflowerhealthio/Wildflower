import { Schema } from 'effect'

import * as DateSearchParam from '../search/date-search-param.ts'
import { StatusSchema } from './imaging-study.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  subject: Schema.optional(Schema.String),
  started: Schema.optional(DateSearchParam.Schema),
  modality: Schema.optional(Schema.String),
  basedOn: Schema.optional(Schema.String),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
