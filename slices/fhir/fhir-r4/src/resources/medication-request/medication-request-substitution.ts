import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../../data-types/base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../../data-types/base/choice-element-set.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'

// FHIR R4 `MedicationRequest.substitution` — the prescriber's intent about
// whether a different drug may be dispensed.
const MedicationRequestSubstitutionStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    ...choiceElementSetPassthroughFields(
      'allowed',
      ChoiceElementSet.FhirR4SetChoices['MedicationRequest.substitution.allowed[x]']
    ),
    reason: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
  })
).pipe(
  filterForExclusiveChoiceElementSet(
    'allowed',
    ChoiceElementSet.FhirR4SetChoices['MedicationRequest.substitution.allowed[x]']
  )
)

const MedicationRequestSubstitutionSchema: Schema.Schema<
  typeof MedicationRequestSubstitutionStruct.Type,
  FhirR4.MedicationRequestSubstitution,
  never
> = MedicationRequestSubstitutionStruct

export { MedicationRequestSubstitutionSchema as Schema }
