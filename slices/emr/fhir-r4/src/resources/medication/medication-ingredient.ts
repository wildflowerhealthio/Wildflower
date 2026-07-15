import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as Reference from '../../data-types/complex/identifier-and-reference.ts'
import * as Ratio from '../../data-types/complex/ratio.ts'

// FHIR R4 `Medication.ingredient` — a constituent of the medication. `item[x]`
// is a required choice (substance CodeableConcept or a Medication/Substance
// Reference); modelled as two nullable passthrough fields, lenient about which
// is present.
const MedicationIngredientStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    itemCodeableConcept: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    itemReference: OrNullAsOptional(Schema.suspend(() => Reference.ReferenceSchema)),
    isActive: OrNullAsOptional(Schema.Boolean),
    strength: OrNullAsOptional(Schema.suspend(() => Ratio.Schema)),
  })
)

const MedicationIngredientSchema: Schema.Schema<
  typeof MedicationIngredientStruct.Type,
  FhirR4.MedicationIngredient,
  never
> = MedicationIngredientStruct

export { MedicationIngredientSchema as Schema }
