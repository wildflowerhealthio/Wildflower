import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import { CodeableConcept, DomainResource } from 'fhir-r4/data-types'
import type * as FhirR4 from 'fhir/r4.d.ts'

import type { Stu3DomainResourceEncoded, Stu3DomainResourceFields } from './base.ts'

/**
 * Just-enough carebook STU3 `Medication`, as it appears in
 * `MedicationRequest.contained`. Only the fields the dialect emits are modelled
 * — `code` (carrying the DIN coding, see {@link carebook.DIN_CODE_SYSTEM}),
 * `form` (`form.coding`), and the DomainResource extension array (where the
 * dialect places `strength` / `description`). Unknown fields are ignored on
 * decode (Effect's default excess-property behaviour), keeping the schema
 * lenient per the epic's decided scope.
 *
 * Reuses the fhir-r4 datatype schemas: the carebook STU3 wire shapes for these
 * datatypes are identical to R4, so a decoded STU3 datatype value is already a
 * decoded R4 datatype value — which makes the STU3 → R4 transform a near
 * identity for medication `code` / `form`.
 */
const MedicationStruct = mutableEncoded(
  StructNoContext({
    resourceType: Schema.Literal('Medication'),
    ...DomainResource.fields,
    code: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    form: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
  })
)

interface Type extends Stu3DomainResourceFields {
  readonly resourceType: 'Medication'
  readonly code: typeof CodeableConcept.Schema.Type | null
  readonly form: typeof CodeableConcept.Schema.Type | null
}

interface Encoded extends Stu3DomainResourceEncoded {
  resourceType: 'Medication'
  code?: FhirR4.CodeableConcept | undefined
  form?: FhirR4.CodeableConcept | undefined
}

const MedicationSchema: Schema.Schema<Type, Encoded, never> = MedicationStruct

export { MedicationSchema as Schema, type Type, type Encoded }
