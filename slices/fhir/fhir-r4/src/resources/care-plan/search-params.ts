import { Schema } from 'effect'

import * as DateSearchParam from '../search/date-search-param.ts'
import { IntentSchema, StatusSchema } from './care-plan.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `CarePlan` search parameters the typed client can express — paging plus
 * seven filters, a subset of FHIR R4 § CarePlan.search.
 *
 * @remarks
 * `status` and `intent` are narrowed to the `CarePlan` value sets; `date` is a
 * {@link DateSearchParam.Schema} matched against `CarePlan.period`. `subject`,
 * `patient` and `category` pass through as written. The narrowings are
 * catalogued in `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  intent: Schema.optional(IntentSchema),
  subject: Schema.optional(Schema.String),
  patient: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  date: Schema.optional(DateSearchParam.Schema),
})

/** Decoded {@link SearchParams} — one `CarePlan` search query. */
type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
