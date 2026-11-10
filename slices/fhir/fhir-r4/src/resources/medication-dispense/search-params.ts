import { Schema } from 'effect'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

/**
 * The `MedicationDispense` search parameters the typed client can express — paging
 * plus `identifier`, a subset of FHIR R4 § MedicationDispense.search.
 *
 * @remarks
 * `identifier` is a FHIR `token` parameter (a bare value or the
 * `system|value` form, passed through as written; several comma-joined match
 * any of them). The narrowings are catalogued in
 * `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
