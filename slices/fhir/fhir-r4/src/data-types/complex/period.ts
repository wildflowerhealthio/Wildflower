import { type Arbitrary, DateTime, Option, ParseResult, Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import { instantArbitrary } from '../base/primitives.ts'
import { endOfPartialDate } from './partial-date.ts'

/**
 * A `Period.end` `dateTime`, decoded to the last instant it covers: a partial
 * date to the last millisecond of its day, month or year in UTC
 * ({@link endOfPartialDate}), anything else exactly as `Schema.DateTimeUtc`
 * decodes it. Encodes with `DateTime.formatIso`.
 */
const PeriodEndSchema = Schema.transformOrFail(Schema.String, Schema.DateTimeUtcFromSelf, {
  strict: true,
  decode: (wire, options) =>
    Option.match(endOfPartialDate(wire), {
      onNone: () => ParseResult.decodeUnknown(Schema.DateTimeUtc)(wire, options),
      onSome: ParseResult.succeed,
    }),
  encode: (end) => ParseResult.succeed(DateTime.formatIso(end)),
}).annotations({ arbitrary: (): Arbitrary.LazyArbitrary<DateTime.Utc> => instantArbitrary })

const PeriodStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    end: OrNullAsOptional(PeriodEndSchema),
    start: OrNullAsOptional(Schema.DateTimeUtc),
  })
)

/**
 * FHIR R4 `Period`. `start` decodes to the first instant it covers and `end`
 * to the last, a partial date's in UTC: `{ start: '2026-03', end: '2026-03' }`
 * spans `2026-03-01T00:00:00.000Z` through `2026-03-31T23:59:59.999Z`.
 */
const PeriodSchema: Schema.Schema<typeof PeriodStruct.Type, FhirR4.Period, never> = PeriodStruct

registerDatatypeSchema('Period', PeriodSchema)

export { PeriodSchema as Schema }
