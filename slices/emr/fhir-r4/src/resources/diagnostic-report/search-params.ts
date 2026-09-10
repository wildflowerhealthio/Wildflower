import { Schema } from 'effect'

import * as DateSearchParam from '../search/date-search-param.ts'
import { StatusSchema } from './diagnostic-report.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `DiagnosticReport` search parameters the typed client can express —
 * paging plus five filters, a subset of FHIR R4 § DiagnosticReport.search.
 *
 * @remarks
 * `_id`, `identifier`, `category` and `code` are FHIR `token` parameters: a
 * bare `code` or the `system|code` form, passed through as written. `status`
 * is narrowed to {@link StatusSchema}, so an out-of-set code fails to
 * typecheck rather than reaching the server; `date` (which FHIR maps to
 * `effective[x]`) is a {@link DateSearchParam.Schema} — an optional comparison
 * prefix in front of a date literal of any precision. `subject` is the one
 * reference-typed parameter, the `Patient/<id>` string a patient's reports are
 * gathered by. The narrowings that remain are catalogued in
 * `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  subject: Schema.optional(Schema.String),
  date: Schema.optional(DateSearchParam.Schema),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
