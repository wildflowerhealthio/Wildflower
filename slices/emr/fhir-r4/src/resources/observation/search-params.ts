import { Schema } from 'effect'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

const buildWhere = (_: SearchParamsType): undefined => undefined

export { SearchParams, buildWhere, type SearchParamsType }
