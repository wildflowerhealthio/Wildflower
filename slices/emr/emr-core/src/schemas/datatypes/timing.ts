import { Schema } from 'effect'

import {
  AnnotateArrayWithArbitrary,
  StructNoContext,
  type FieldsNoContext,
} from 'kitchen-sink/schema'
import { Schema as BackboneElementSchema } from '../base/backbone-element.ts'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as CodeableConceptSchema } from './codeable-concept.ts'
import { Schema as ElementSchema } from './element.ts'
import { Schema as PeriodSchema } from './period.ts'
import { InstantSchema, TimeSchema } from './primitives.ts'
import { Schema as RangeSchema } from './range.ts'

const ResourceType = 'Timing' as const
type ResourceType = typeof ResourceType

/** FHIR R4 `Timing.repeat.periodUnit` / `Timing.repeat.durationUnit`. */
const UnitOfTimeSchema = Schema.Literal('s', 'min', 'h', 'd', 'wk', 'mo', 'a')

/** FHIR R4 `Timing.repeat.dayOfWeek`. */
const DayOfWeekSchema = Schema.Literal('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')

/** FHIR R4 `TimingRepeat` — the per-period scheduling spec inside `Timing`.
 *
 * Note: `bounds[x]` is modeled as the (Period, Range) subset only.
 * `boundsDuration` is left out pending a registered `Duration` datatype;
 * unregistered slot semantics from PR #61 apply if a payload uses it.
 *
 * `when` values are left as `string` rather than a closed enum so consumers
 * aren't blocked on the full FHIR EventTiming value set.
 */
const TimingRepeatSchema = StructNoContext({
  ...ElementSchema.fields,
  boundsPeriod: Schema.NullOr(PeriodSchema),
  boundsRange: Schema.NullOr(RangeSchema),
  count: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  countMax: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  duration: Schema.NullOr(Schema.Finite),
  durationMax: Schema.NullOr(Schema.Finite),
  durationUnit: Schema.NullOr(UnitOfTimeSchema),
  frequency: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  frequencyMax: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  period: Schema.NullOr(Schema.Finite),
  periodMax: Schema.NullOr(Schema.Finite),
  periodUnit: Schema.NullOr(UnitOfTimeSchema),
  dayOfWeek: Schema.Array(DayOfWeekSchema),
  timeOfDay: Schema.Array(TimeSchema),
  when: Schema.Array(Schema.String),
  offset: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())),
})

const fields = {
  // `effectiveTiming` round-trip tests blow the per-test budget when `event`
  // grows unbounded (each entry is an `InstantSchema` and the parent struct
  // nests through every choice slot). Cap arbitrary array length here on the
  // store-side schema so `Arbitrary.make(StoreTiming.Schema)` — what both
  // emr-core and the fhir-r4 adapter tests pull from — stays tractable.
  event: Schema.Array(InstantSchema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  repeat: Schema.NullOr(TimingRepeatSchema),
  code: Schema.NullOr(CodeableConceptSchema),
} as const satisfies FieldsNoContext

/**
 * A scheduled or scheduled-with-repeats event. Used for medication
 * administration timing, observation cycles, recurring appointments, etc.
 *
 * `Timing` extends FHIR R4 `BackboneElement` (not `Element`), so the struct
 * spreads `BackboneElement.fields` to carry `modifierExtension` through
 * encode/decode alongside `Element`'s `id` / `extension`.
 */
const TimingSchema = StructNoContext({
  ...BackboneElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, TimingSchema)

export {
  DayOfWeekSchema,
  ResourceType,
  TimingRepeatSchema,
  TimingSchema as Schema,
  UnitOfTimeSchema,
}
