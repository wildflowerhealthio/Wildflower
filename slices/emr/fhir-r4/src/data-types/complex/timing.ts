import { type DateTime, Schema } from 'effect'

import { Timing as StoreTiming } from 'emr-core/schemas'
import {
  AnnotateArrayWithArbitrary,
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as CodeableConcept from './codeable-concept.ts'
import * as Period from './period.ts'
import * as Range from './range.ts'

const TimingRepeatSchema: Schema.Schema<
  typeof StoreTiming.TimingRepeatSchema.Type,
  FhirR4.TimingRepeat,
  never
> = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    // bounds[x]: the (Range, Period) subset. boundsDuration is omitted —
    // Duration is unregistered, so the wire encoder would reject any non-null
    // value per the unregistered-slot contract from PR #61.
    boundsPeriod: OrNullAsOptional(Period.Schema),
    boundsRange: OrNullAsOptional(Range.Schema),
    count: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    countMax: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    duration: OrNullAsOptional(Schema.Finite),
    durationMax: OrNullAsOptional(Schema.Finite),
    durationUnit: OrNullAsOptional(StoreTiming.UnitOfTimeSchema),
    frequency: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    frequencyMax: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    period: OrNullAsOptional(Schema.Finite),
    periodMax: OrNullAsOptional(Schema.Finite),
    periodUnit: OrNullAsOptional(StoreTiming.UnitOfTimeSchema),
    dayOfWeek: Schema.optionalWith(mutableEncoded(Schema.Array(StoreTiming.DayOfWeekSchema)), {
      default: (): readonly (typeof StoreTiming.DayOfWeekSchema.Type)[] => [],
    }),
    timeOfDay: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: (): readonly string[] => [],
    }),
    when: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: (): readonly string[] => [],
    }),
    offset: OrNullAsOptional(Schema.Int.pipe(Schema.nonNegative())),
  })
)

const TimingSchema: Schema.Schema<typeof StoreTiming.Schema.Type, FhirR4.Timing, never> =
  mutableEncoded(
    StructNoContext({
      ...Element.fields,
      event: Schema.Array(Schema.DateTimeUtc).pipe(
        AnnotateArrayWithArbitrary({ maxLength: 2 }),
        mutableEncoded,
        Schema.optionalWith({ default: (): readonly DateTime.Utc[] => [] })
      ),
      repeat: OrNullAsOptional(TimingRepeatSchema),
      code: OrNullAsOptional(CodeableConcept.Schema),
    })
  )

registerDatatypeSchema('Timing', TimingSchema)

export { TimingSchema as Schema, TimingRepeatSchema }
