import { Schema } from 'effect'

import { AdministrativeGender } from '../../data-types/complex/administrative-gender.ts'
import * as DateSearchParam from '../search/date-search-param.ts'

const NumFromStr = Schema.NumberFromString.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))

const BoolFromStr = Schema.transform(Schema.Literal('true', 'false'), Schema.Boolean, {
  decode: (s) => s === 'true',
  encode: (b): 'true' | 'false' => {
    if (b) {
      return 'true'
    } else {
      return 'false'
    }
  },
})

/**
 * The `Patient` search parameters the typed client can express — paging plus
 * four filters, a subset of FHIR R4 § Patient.search.
 *
 * @remarks
 * `identifier` is a FHIR `token` parameter (a bare value or the
 * `system|value` form, passed through as written) — what finds the person a
 * source identifier already names. The narrowings that remain are catalogued
 * in `fhir-r4/docs/Client Capabilities Reference.md`.
 */
const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  identifier: Schema.optional(Schema.String),
  gender: Schema.optional(AdministrativeGender),
  active: Schema.optional(BoolFromStr),
  // FHIR `birthdate` search param maps to `Patient.birthDate`. A
  // `DateSearchParam` value: an optional comparison prefix in front of a date
  // literal of any precision (`ge2000`, `2000-05`, `lt2000-05-01`), carrying
  // the period that precision implies.
  birthdate: Schema.optional(DateSearchParam.Schema),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
