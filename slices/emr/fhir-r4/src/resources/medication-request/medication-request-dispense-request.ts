import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as BackboneElement from '../../data-types/base/backbone-element.ts'
import * as Duration from '../../data-types/complex/duration.ts'
import * as Reference from '../../data-types/complex/identifier-and-reference.ts'
import * as Period from '../../data-types/complex/period.ts'
import * as Quantity from '../../data-types/complex/quantity.ts'

// FHIR R4 `MedicationRequest.dispenseRequest.initialFill` — quantity/duration
// of the first dispense. Co-located with its parent backbone (mirrors
// `timing.ts`'s Timing + TimingRepeat).
const InitialFillStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    quantity: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
    duration: OrNullAsOptional(Schema.suspend(() => Duration.Schema)),
  })
)

const InitialFillSchema: Schema.Schema<
  typeof InitialFillStruct.Type,
  FhirR4.MedicationRequestDispenseRequestInitialFill,
  never
> = InitialFillStruct

// FHIR R4 `MedicationRequest.dispenseRequest` — the medication-supply
// authorization portion of the request.
const MedicationRequestDispenseRequestStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    initialFill: OrNullAsOptional(InitialFillSchema),
    dispenseInterval: OrNullAsOptional(Schema.suspend(() => Duration.Schema)),
    validityPeriod: OrNullAsOptional(Schema.suspend(() => Period.Schema)),
    numberOfRepeatsAllowed: OrNullAsOptional(Schema.Int.pipe(Schema.nonNegative())),
    quantity: OrNullAsOptional(Schema.suspend(() => Quantity.Schema)),
    expectedSupplyDuration: OrNullAsOptional(Schema.suspend(() => Duration.Schema)),
    performer: OrNullAsOptional(Schema.suspend(() => Reference.ReferenceSchema)),
  })
)

/** An all-empty R4 `MedicationRequest.dispenseRequest` backbone. */
const empty: typeof MedicationRequestDispenseRequestStruct.Type = {
  id: null,
  extension: [],
  modifierExtension: [],
  initialFill: null,
  dispenseInterval: null,
  validityPeriod: null,
  numberOfRepeatsAllowed: null,
  quantity: null,
  expectedSupplyDuration: null,
  performer: null,
}

const MedicationRequestDispenseRequestSchema: Schema.Schema<
  typeof MedicationRequestDispenseRequestStruct.Type,
  FhirR4.MedicationRequestDispenseRequest,
  never
> = MedicationRequestDispenseRequestStruct

export { MedicationRequestDispenseRequestSchema as Schema, InitialFillSchema, empty }
