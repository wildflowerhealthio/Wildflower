import { type Arbitrary, type DateTime, type FastCheck, Schema } from 'effect'

import { Datatype, Timing as StoreTiming } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../base/backbone-element.ts'
import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as CodeableConcept from './codeable-concept.ts'
import * as Period from './period.ts'
import * as Range from './range.ts'

// Local FHIR R4 `time` (`hh:mm:ss[.fff]`) primitive. Mirrors the emr-core
// `TimeSchema` rather than re-exporting it so the wire-format adapter can
// evolve its encoding independently — e.g. tightening the arbitrary set or
// adding a transform — without coupling the store side. The Type is `string`,
// matching `FhirR4.time`, and equal to `StoreTiming.TimingRepeatSchema`'s
// `timeOfDay` element type, so wire decode lands directly in the store
// schema.
const TimeSchema: Schema.Schema<string, string, never> = Schema.String.pipe(
  Schema.pattern(/^([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?$/),
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc: typeof FastCheck) =>
      fc.constantFrom(
        '00:00:00',
        '23:59:59',
        '23:59:60',
        '12:30:45',
        '12:30:45.1',
        '12:30:45.123',
        '12:30:45.123456789',
        '06:15:30',
        '18:45:00.5'
      ),
  })
)

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
    timeOfDay: Schema.optionalWith(mutableEncoded(Schema.Array(TimeSchema)), {
      default: (): readonly string[] => [],
    }),
    when: Schema.optionalWith(mutableEncoded(Schema.Array(Schema.String)), {
      default: (): readonly string[] => [],
    }),
    offset: OrNullAsOptional(Schema.Int.pipe(Schema.nonNegative())),
  })
)

// `Timing` extends FHIR R4 `BackboneElement` — spread its fields (not
// `Element.fields`) so `modifierExtension` round-trips alongside `id` /
// `extension`. The `event` array length cap lives on the emr-core
// `timing.ts` `event` field (the store-side schema is what
// `Arbitrary.make` is invoked against in both layers' tests).
const TimingSchema: Schema.Schema<typeof StoreTiming.Schema.Type, FhirR4.Timing, never> =
  mutableEncoded(
    StructNoContext({
      ...BackboneElement.fields,
      event: Schema.Array(Datatype.baseSchemas.instant).pipe(
        mutableEncoded,
        Schema.optionalWith({ default: (): readonly DateTime.Utc[] => [] })
      ),
      repeat: OrNullAsOptional(TimingRepeatSchema),
      code: OrNullAsOptional(CodeableConcept.Schema),
    })
  )

registerDatatypeSchema('Timing', TimingSchema)

export { TimingSchema as Schema, TimingRepeatSchema }
