import { Schema } from 'effect'

import { AdministrativeGender } from '../../data-types/complex/administrative-gender.ts'

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

const SearchParams = Schema.Struct({
  _count: Schema.optional(NumFromStr.pipe(Schema.between(0, 1000))),
  _pageToken: Schema.optional(Schema.String),
  gender: Schema.optional(AdministrativeGender),
  active: Schema.optional(BoolFromStr),
  // FHIR `birthdate` search param maps to `Patient.birthDate`. Equality
  // only in baseline; date prefixes (gt/lt/ge/le/sa/eb/ap) and partial-precision
  // ranges are not yet supported.
  birthdate: Schema.optional(Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/))),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

export { SearchParams, type SearchParamsType }
