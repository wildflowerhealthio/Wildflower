import { Schema } from 'effect'

import { Schema as ElementSchema } from '../base/element.ts'
import { Datatype as makeDatatype } from '../datatype.ts'

const ResourceType = 'Period' as const
type ResourceType = typeof ResourceType

const fields = {
  /**
   * The start of the period. The boundary is inclusive.
   * If the low element is missing, the meaning is that the low boundary is not known.
   */
  start: Schema.NullOr(Schema.DateTimeUtc),
  /**
   * The end of the period. If the end of the period is missing, it means no end was known or planned at the time the instance was created. The start may be in the past, and the end date in the future, which means that period is expected/planned to end at that time.
   * The high value includes any matching date/time. i.e. 2012-02-03T10:00:00 is in a period that has an end value of 2012-02-03.
   */
  end: Schema.NullOr(Schema.DateTimeUtc),
} as const satisfies Schema.Struct.Fields

/**
 * A time period defined by a start and end date/time.
 * A period specifies a range of times. The context of use will specify whether the entire period applies (e.g. "the patient was an inpatient of the hospital for this time range") or one value from the period applies (e.g. "give to the patient between 2 and 4 pm on 24-Jun 2013").
 */
const PeriodSchema = Schema.Struct({
  ...ElementSchema.fields,
  ...fields,
})

const Datatype = makeDatatype(ResourceType, PeriodSchema)

export { Datatype, ResourceType, PeriodSchema as Schema }
