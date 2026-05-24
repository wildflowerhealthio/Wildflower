import { type Schema } from 'effect'

import type { Range as StoreRange } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Quantity from './quantity.ts'

const RangeSchema: Schema.Schema<typeof StoreRange.Schema.Type, FhirR4.Range, never> =
  mutableEncoded(
    StructNoContext({
      ...Element.fields,
      high: OrNullAsOptional(Quantity.Schema),
      low: OrNullAsOptional(Quantity.Schema),
    })
  )

registerDatatypeSchema('Range', RangeSchema)

export { RangeSchema as Schema }
