import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../base/backbone-element.ts'
import {
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
} from '../base/choice-element-passthrough-fields.ts'
import * as ChoiceElementSet from '../base/choice-element-set.ts'
import * as CodeableConcept from './codeable-concept.ts'
import * as Range from './range.ts'
import * as Ratio from './ratio.ts'
import * as SimpleQuantity from './simple-quantity.ts'
import * as Timing from './timing.ts'

// FHIR R4 `DosageDoseAndRate` — the amount/rate of medication administered.
//
// `dose[x]` and `rate[x]` are modeled as explicit fields rather than via
// `choiceElementSetPassthroughFields`: the R4 choice type is `SimpleQuantity`,
// but FHIR names the JSON property with the base type ("Quantity"), so the wire
// fields are `doseQuantity` / `rateQuantity` — not the `doseSimpleQuantity`
// the passthrough helper would derive from the datatype name.
const DosageDoseAndRateStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    doseRange: OrNullAsOptional(Schema.suspend(() => Range.Schema)),
    doseQuantity: OrNullAsOptional(Schema.suspend(() => SimpleQuantity.Schema)),
    rateRatio: OrNullAsOptional(Schema.suspend(() => Ratio.Schema)),
    rateRange: OrNullAsOptional(Schema.suspend(() => Range.Schema)),
    rateQuantity: OrNullAsOptional(Schema.suspend(() => SimpleQuantity.Schema)),
  })
)

const DosageDoseAndRateSchema: Schema.Schema<
  typeof DosageDoseAndRateStruct.Type,
  FhirR4.DosageDoseAndRate,
  never
> = DosageDoseAndRateStruct

// FHIR R4 `Dosage` — how a medication is/was taken by the patient. Extends
// `BackboneElement` (spread its fields so `modifierExtension` round-trips).
const DosageStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    sequence: OrNullAsOptional(Schema.Int),
    text: OrNullAsOptional(Schema.String),
    additionalInstruction: Schema.optionalWith(
      mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
      { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
    ),
    patientInstruction: OrNullAsOptional(Schema.String),
    timing: OrNullAsOptional(Schema.suspend(() => Timing.Schema)),
    ...choiceElementSetPassthroughFields(
      'asNeeded',
      ChoiceElementSet.FhirR4SetChoices['Dosage.asNeeded[x]']
    ),
    site: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    route: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    method: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    doseAndRate: Schema.optionalWith(mutableEncoded(Schema.Array(DosageDoseAndRateSchema)), {
      default: (): readonly (typeof DosageDoseAndRateSchema.Type)[] => [],
    }),
    maxDosePerPeriod: OrNullAsOptional(Schema.suspend(() => Ratio.Schema)),
    maxDosePerAdministration: OrNullAsOptional(Schema.suspend(() => SimpleQuantity.Schema)),
    maxDosePerLifetime: OrNullAsOptional(Schema.suspend(() => SimpleQuantity.Schema)),
  })
).pipe(
  filterForExclusiveChoiceElementSet(
    'asNeeded',
    ChoiceElementSet.FhirR4SetChoices['Dosage.asNeeded[x]']
  )
)

const DosageSchema: Schema.Schema<typeof DosageStruct.Type, FhirR4.Dosage, never> = DosageStruct

export { DosageSchema as Schema, DosageDoseAndRateSchema }
