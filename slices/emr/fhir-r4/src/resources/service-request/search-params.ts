import { Schema } from 'effect'

import * as DateSearchParam from '../search/date-search-param.ts'
import { IntentSchema, StatusSchema } from './service-request.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `ServiceRequest` search parameters the typed client can express —
 * paging plus eleven filters, a subset of FHIR R4 § ServiceRequest.search.
 *
 * @remarks
 * `status` and `intent` are narrowed to their value sets; `authored` is a
 * {@link DateSearchParam.Schema}. `identifier`, `code`, `subject`, `patient`,
 * `category`, `instantiates-canonical` and `based-on` pass through as
 * written. The narrowings are catalogued in
 * `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  intent: Schema.optional(IntentSchema),
  code: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  patient: Schema.optional(Schema.String),
  authored: Schema.optional(DateSearchParam.Schema),
  category: Schema.optional(Schema.String),
  'instantiates-canonical': Schema.optional(Schema.String),
  'based-on': Schema.optional(Schema.String),
})

/** Decoded {@link SearchParams} — one `ServiceRequest` search query. */
type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
