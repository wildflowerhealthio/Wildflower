import { Schema } from 'effect'

import { StructNoContext, type FieldsNoContext } from 'kitchen-sink/schema'
import { registerDatatypeSchema } from '../datatype-registry.ts'
import { Schema as ElementSchema } from './element.ts'
import { Schema as SimpleQuantitySchema } from './simple-quantity.ts'

const ResourceType = 'SampledData' as const
type ResourceType = typeof ResourceType

const fields = {
  /** Zero value and units of the measurement. */
  origin: SimpleQuantitySchema,
  /** Length of time between samples (milliseconds). */
  period: Schema.Finite,
  /** Multiplier applied to raw data values to convert to final units. */
  factor: Schema.NullOr(Schema.Finite),
  /** Lower limit of detection. */
  lowerLimit: Schema.NullOr(Schema.Finite),
  /** Upper limit of detection. */
  upperLimit: Schema.NullOr(Schema.Finite),
  /** Number of sample points at each time point (1..*). */
  dimensions: Schema.Int.pipe(Schema.positive()),
  /** Whitespace-separated sample values, encoded per `factor` and limits. */
  data: Schema.NullOr(Schema.String),
} as const satisfies FieldsNoContext

/**
 * A series of measurements taken by a device. Used for periodic device output
 * (e.g. ECG, blood-pressure trace). The values themselves live in `data`
 * encoded as whitespace-separated numbers.
 */
const SampledDataSchema = StructNoContext({
  ...ElementSchema.fields,
  ...fields,
})

registerDatatypeSchema(ResourceType, SampledDataSchema)

export { ResourceType, SampledDataSchema as Schema }
