import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as Reference from '../../data-types/complex/identifier-and-reference.ts'

// FHIR R4 `MedicationDispense.substitution` — whether a substitution was made
// as part of the dispense. `wasSubstituted` is required (1..1).
const MedicationDispenseSubstitutionStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    wasSubstituted: Schema.Boolean,
    type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    reason: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    responsibleParty: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => Reference.ReferenceSchema))),
      { default: (): readonly (typeof Reference.ReferenceSchema.Type)[] => [] }
    ),
  })
)

const MedicationDispenseSubstitutionSchema: Schema.Schema<
  typeof MedicationDispenseSubstitutionStruct.Type,
  FhirR4.MedicationDispenseSubstitution,
  never
> = MedicationDispenseSubstitutionStruct

export { MedicationDispenseSubstitutionSchema as Schema }
