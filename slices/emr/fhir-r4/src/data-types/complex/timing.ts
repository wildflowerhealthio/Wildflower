import { type Arbitrary, type DateTime, type FastCheck, Schema } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../base/backbone-element.ts'
import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Datatype from '../base/datatype.ts'
import * as Element from '../base/element.ts'
import * as CodeableConcept from './codeable-concept.ts'
import * as Period from './period.ts'
import * as Range from './range.ts'

// Local FHIR R4 `time` (`hh:mm:ss[.fff]`) primitive. Mirrors the base
// `TimeSchema` rather than re-exporting it so the wire-format schema can
// evolve its encoding independently — e.g. tightening the arbitrary set or
// adding a transform. The Type is `string`, matching `FhirR4.time`.
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

/** FHIR R4 `Timing.repeat.periodUnit` / `Timing.repeat.durationUnit`. */
const UnitOfTimeSchema = Schema.Literal('s', 'min', 'h', 'd', 'wk', 'mo', 'a')

/** FHIR R4 `Timing.repeat.dayOfWeek`. */
const DayOfWeekSchema = Schema.Literal('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')

/** FHIR R4 `Timing.repeat.when` — the `EventTiming` value set (real-world
 * events the schedule is tied to, e.g. meals and sleep). */
const EventTimingSchema = Schema.Literal(
  'MORN',
  'MORN.early',
  'MORN.late',
  'NOON',
  'AFT',
  'AFT.early',
  'AFT.late',
  'EVE',
  'EVE.early',
  'EVE.late',
  'NIGHT',
  'PHS',
  'HS',
  'WAKE',
  'C',
  'CM',
  'CD',
  'CV',
  'AC',
  'ACM',
  'ACD',
  'ACV',
  'PC',
  'PCM',
  'PCD',
  'PCV'
)

const TimingRepeatStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    // bounds[x]: the (Range, Period) subset. boundsDuration is not modeled.
    // Duration is registered now, so nothing rejects it any more — adding the
    // field is just a change nobody has needed yet.
    boundsPeriod: OrNullAsOptional(Period.Schema),
    boundsRange: OrNullAsOptional(Range.Schema),
    count: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    countMax: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    duration: OrNullAsOptional(Schema.Finite),
    durationMax: OrNullAsOptional(Schema.Finite),
    durationUnit: OrNullAsOptional(UnitOfTimeSchema),
    frequency: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    frequencyMax: OrNullAsOptional(Schema.Int.pipe(Schema.positive())),
    period: OrNullAsOptional(Schema.Finite),
    periodMax: OrNullAsOptional(Schema.Finite),
    periodUnit: OrNullAsOptional(UnitOfTimeSchema),
    dayOfWeek: Schema.optionalWith(mutableEncoded(Schema.Array(DayOfWeekSchema)), {
      default: (): readonly (typeof DayOfWeekSchema.Type)[] => [],
    }),
    timeOfDay: Schema.optionalWith(mutableEncoded(Schema.Array(TimeSchema)), {
      default: (): readonly string[] => [],
    }),
    when: Schema.optionalWith(mutableEncoded(Schema.Array(EventTimingSchema)), {
      default: (): readonly (typeof EventTimingSchema.Type)[] => [],
    }),
    offset: OrNullAsOptional(Schema.Int.pipe(Schema.nonNegative())),
  })
)

const TimingRepeatSchema: Schema.Schema<
  typeof TimingRepeatStruct.Type,
  FhirR4.TimingRepeat,
  never
> = TimingRepeatStruct

// `Timing` extends FHIR R4 `BackboneElement` — spread its fields (not
// `Element.fields`) so `modifierExtension` round-trips alongside `id` /
// `extension`.
const TimingStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    // Cap `event`'s arbitrary length: `effectiveTiming` round-trip property
    // tests blow the per-test budget when `event` grows unbounded (each entry
    // is an `InstantSchema` and the parent struct nests through every choice
    // slot).
    event: Schema.Array(Datatype.baseSchemas.instant).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 }),
      mutableEncoded,
      Schema.optionalWith({ default: (): readonly DateTime.Utc[] => [] })
    ),
    repeat: OrNullAsOptional(TimingRepeatSchema),
    code: OrNullAsOptional(CodeableConcept.Schema),
  })
)

const TimingSchema: Schema.Schema<typeof TimingStruct.Type, FhirR4.Timing, never> = TimingStruct

registerDatatypeSchema('Timing', TimingSchema)

export { TimingSchema as Schema, TimingRepeatSchema }
