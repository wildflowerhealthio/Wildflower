import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import { CodeableConcept, DomainResource } from 'fhir-r4/data-types'

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
const MedicationStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Medication') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      code: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      form: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    })
  )
)

type Type = typeof MedicationStruct.Type

const MedicationSchema: Schema.Schema<Type, typeof MedicationStruct.Encoded, never> =
  MedicationStruct

export { MedicationSchema as Schema, type Type }
