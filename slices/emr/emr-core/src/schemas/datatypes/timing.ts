import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as CodeableConceptSchema } from './codeable-concept.ts'
import { Schema as ElementSchema } from './element.ts'
import { Schema as PeriodSchema } from './period.ts'
import { InstantSchema, TimeSchema } from './primitives.ts'
import { Schema as RangeSchema } from './range.ts'

const ResourceType = 'Timing' as const
type ResourceType = typeof ResourceType

/** FHIR R4 `Timing.repeat.periodUnit` / `Timing.repeat.durationUnit`. */
const UnitOfTimeSchema = Schema.Union(
  Schema.Literal('s'),
  Schema.Literal('min'),
  Schema.Literal('h'),
  Schema.Literal('d'),
  Schema.Literal('wk'),
  Schema.Literal('mo'),
  Schema.Literal('a')
)

/** FHIR R4 `Timing.repeat.dayOfWeek`. */
const DayOfWeekSchema = Schema.Union(
  Schema.Literal('mon'),
  Schema.Literal('tue'),
  Schema.Literal('wed'),
  Schema.Literal('thu'),
  Schema.Literal('fri'),
  Schema.Literal('sat'),
  Schema.Literal('sun')
)

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
  event: Schema.Array(InstantSchema),
  repeat: Schema.NullOr(TimingRepeatSchema),
  code: Schema.NullOr(CodeableConceptSchema),
} as const satisfies FieldsNoContext

/**
 * A scheduled or scheduled-with-repeats event. Used for medication
 * administration timing, observation cycles, recurring appointments, etc.
 */
const TimingSchema = StructNoContext({
  ...ElementSchema.fields,
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
