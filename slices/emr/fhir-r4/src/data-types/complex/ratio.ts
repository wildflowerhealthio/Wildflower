import type { Schema } from 'effect'

import type { Ratio as StoreRatio } from 'emr-core/schemas'
import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'
import * as Quantity from './quantity.ts'

const RatioSchema: Schema.Schema<typeof StoreRatio.Schema.Type, FhirR4.Ratio, never> =
  mutableEncoded(
    StructNoContext({
      ...Element.fields,
      numerator: OrNullAsOptional(Quantity.Schema),
      denominator: OrNullAsOptional(Quantity.Schema),
    })
  )

registerDatatypeSchema('Ratio', RatioSchema)

export { RatioSchema as Schema }
