import { Schema } from 'effect'

import * as DateSearchParam from '../search/date-search-param.ts'
import { StatusSchema } from './observation.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `Observation` search parameters the typed client can express — paging
 * plus ten filters, a subset of FHIR R4 § Observation.search.
 *
 * @remarks
 * `status` is narrowed to the `Observation` value set; `date` is a
 * {@link DateSearchParam.Schema}, matched by the server against
 * `effective[x]`. `identifier`, `category`, `code`, `subject`, `patient`,
 * `based-on` and `part-of` pass through as written. The narrowings are
 * catalogued in `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  category: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  patient: Schema.optional(Schema.String),
  date: Schema.optional(DateSearchParam.Schema),
  'based-on': Schema.optional(Schema.String),
  'part-of': Schema.optional(Schema.String),
})

/** Decoded {@link SearchParams} — one `Observation` search query. */
type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
