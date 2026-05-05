import { Schema } from 'effect'

import type { Period as StorePeriod } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as Element from '../base/element.ts'

const PeriodSchema: Schema.Schema<typeof StorePeriod.Schema.Type, FhirR4.Period, never> =
  mutableEncoded(
    StructNoContext({
      ...Element.fields,
      end: OrNullAsOptional(Schema.DateTimeUtc),
      start: OrNullAsOptional(Schema.DateTimeUtc),
    })
  )

export { PeriodSchema as Schema }
