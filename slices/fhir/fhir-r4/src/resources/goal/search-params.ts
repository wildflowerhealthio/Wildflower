import { Schema } from 'effect'

import { LifecycleStatusSchema } from './goal.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `Goal` search parameters the typed client can express — paging plus
 * four filters, a subset of FHIR R4 § Goal.search.
 *
 * @remarks
 * `lifecycle-status` is narrowed to the `Goal.lifecycleStatus` value set;
 * `subject` and `patient` pass through as written. The narrowings are
 * catalogued in `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  'lifecycle-status': Schema.optional(LifecycleStatusSchema),
  subject: Schema.optional(Schema.String),
  patient: Schema.optional(Schema.String),
})

/** Decoded {@link SearchParams} — one `Goal` search query. */
type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
