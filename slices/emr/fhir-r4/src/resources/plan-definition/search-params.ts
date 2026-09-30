import { Schema } from 'effect'

import * as DateSearchParam from '../search/date-search-param.ts'
import { StatusSchema } from './plan-definition.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `PlanDefinition` search parameters the typed client can express — paging
 * plus seven filters, a subset of FHIR R4 § PlanDefinition.search.
 *
 * @remarks
 * `status` is narrowed to the `PlanDefinition` value set; `date` is a
 * {@link DateSearchParam.Schema}. `identifier`, `url`, `name` and `title` pass
 * through as written. The narrowings are catalogued in
 * `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  date: Schema.optional(DateSearchParam.Schema),
})

/** Decoded {@link SearchParams} — one `PlanDefinition` search query. */
type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
