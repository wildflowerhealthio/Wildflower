import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { Code } from '../base/code.ts'
import { registerDatatypeSchema } from '../base/datatype-registry.ts'
import * as Element from '../base/element.ts'

// FHIR R4 `Duration` is a specialization of `Quantity` (`Duration extends
// Quantity` in the R4 type set), so the wire shape is identical to Quantity.
//
// Duration is reachable both as a directly-named field (MedicationRequest's
// dispense-request durations) and through a `value[x]` / `bounds[x]` choice
// slot — web-trace's response-timing extension carries a `valueDuration` — so
// it registers itself like every other complex datatype here. That is what
// makes `Extension.valueDuration` and `Timing.repeat.boundsDuration`
// round-trip rather than fail encode with `UnregisteredDatatype`.
const DurationStruct = mutableEncoded(
  StructNoContext({
    ...Element.fields,
    code: OrNullAsOptional(Code),
    comparator: OrNullAsOptional(
      Schema.Union(
        Schema.Literal('<'),
        Schema.Literal('<='),
        Schema.Literal('>='),
        Schema.Literal('>')
      )
    ),
    system: OrNullAsOptional(Schema.String),
    unit: OrNullAsOptional(Schema.String),
    value: OrNullAsOptional(Schema.Finite),
  })
)

const DurationSchema: Schema.Schema<typeof DurationStruct.Type, FhirR4.Duration, never> =
  DurationStruct

registerDatatypeSchema('Duration', DurationSchema)

export { DurationSchema as Schema }
