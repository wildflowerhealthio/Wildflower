import { Schema } from 'effect'

import { StatusSchema } from './document-reference.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `DocumentReference` search parameters the typed client can express —
 * paging plus six filters, a subset of FHIR R4 § DocumentReference.search.
 *
 * @remarks
 * `_id`, `identifier`, `category` and `type` are FHIR `token` parameters: a
 * bare `code` or the `system|code` form, passed through as written. `status`
 * is narrowed to {@link StatusSchema}, so an out-of-set code fails to
 * typecheck rather than reaching the server; `date` travels as an ISO 8601
 * instant. The narrowings that remain — no reference-typed parameters, no
 * date prefixes or partial-precision ranges, one value per key — are
 * catalogued in `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  status: Schema.optional(StatusSchema),
  date: Schema.optional(Schema.DateTimeUtc),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
