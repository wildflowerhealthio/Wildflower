import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'

const PeriodStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    end: OrNullAsOptional(Schema.DateTimeUtc),
    start: OrNullAsOptional(Schema.DateTimeUtc),
  })
)

const PeriodSchema: Schema.Schema<typeof PeriodStruct.Type, FhirR4.Period, never> = PeriodStruct

registerDatatypeSchema('Period', PeriodSchema)

export { PeriodSchema as Schema }
