import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as Reference from '../../data-types/complex/identifier-and-reference.ts'

// FHIR R4 `MedicationDispense.performer` — who (or what) performed the dispense
// event. `actor` is required (1..1).
const MedicationDispensePerformerStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    function: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    actor: Schema.suspend(() => Reference.ReferenceSchema),
  })
)

const MedicationDispensePerformerSchema: Schema.Schema<
  typeof MedicationDispensePerformerStruct.Type,
  FhirR4.MedicationDispensePerformer,
  never
> = MedicationDispensePerformerStruct

export { MedicationDispensePerformerSchema as Schema }
