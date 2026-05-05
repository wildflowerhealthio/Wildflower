import type { QueryBuilder } from '@livestore/livestore'
import { Schema } from 'effect'

import type { Patient as StorePatient } from 'emr-core/livestore'
import { AdministrativeGender } from 'emr-core/schemas'

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
  // FHIR `birthdate` search param maps to `Patient.birthDate` column. Equality
  // only in baseline; date prefixes (gt/lt/ge/le/sa/eb/ap) and partial-precision
  // ranges are not yet supported.
  birthdate: Schema.optional(Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/))),
})

type SearchParamsType = Schema.Schema.Type<typeof SearchParams>

type WhereType = QueryBuilder.WhereParams<typeof StorePatient.table>

const buildWhere = (p: SearchParamsType): WhereType | undefined => {
  const where: { -readonly [K in keyof WhereType]: WhereType[K] } = {}
  let any = false
  if (p.gender !== undefined) {
    where.gender = p.gender
    any = true
  }
  if (p.active !== undefined) {
    where.active = p.active
    any = true
  }
  if (p.birthdate !== undefined) {
    /* oxlint-disable-next-line typescript/no-unsafe-type-assertion -- branded TimelessDate string at runtime is a plain string */
    where.birthDate = p.birthdate as typeof where.birthDate
    any = true
  }
  if (!any) {
    return undefined
  }
  return where
}

export { SearchParams, buildWhere, type SearchParamsType }
