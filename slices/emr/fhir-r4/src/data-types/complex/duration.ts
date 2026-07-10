import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import { Code } from '../base/code.ts'
import * as Element from '../base/element.ts'

// FHIR R4 `Duration` is a specialization of `Quantity` (`Duration extends
// Quantity` in the R4 type set), so the wire shape is identical to Quantity.
//
// Unlike the other complex datatypes in this directory, Duration does NOT
// register itself with the datatype registry: it only ever appears as a
// directly-named field (MedicationRequest's dispense-request durations),
// never through a `value[x]` / `bounds[x]` choice slot, and it is not part of
// the registry manifest (`baseDatatypes`). Consumers reference
// `Duration.Schema` directly. `Timing.repeat.boundsDuration` therefore remains
// unregistered — see the Client Capabilities Reference.
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

export { DurationSchema as Schema }
