import { Schema } from 'effect'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `Practitioner` search parameters the typed client can express — paging
 * plus three filters, a subset of FHIR R4 § Practitioner.search.
 *
 * @remarks
 * `_id` and `identifier` are FHIR `token` parameters (a bare value or the
 * `system|value` form, passed through as written); `name` is a `string`
 * parameter matched against any part of the practitioner's names. The
 * narrowings that remain are catalogued in
 * `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  _id: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
