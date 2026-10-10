import { ParseResult, Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import { CodeableConcept, DomainResource } from 'fhir-r4/data-types'
import { Medication as R4Medication } from 'fhir-r4/resources'

/**
 * Just-enough STU3 `Medication`, as it appears in `MedicationRequest.contained`.
 * Only the fields the dialect emits are modelled — `code`, `form`, and the
 * DomainResource extension array (where the dialect places `strength` /
 * `description`). Unknown fields are ignored on decode (Effect's default
 * excess-property behaviour), keeping the schema lenient per the epic's scope.
 *
 * The STU3 wire shapes for these datatypes are identical to R4, so the clean
 * STU3 value is already structurally an R4 `Medication` for the shared fields;
 * {@link R4FromStu3Schema} is a near-identity that only defaults the R4-only
 * slots (`status`, `manufacturer`, `amount`, `ingredient`, `batch`).
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

/** STU3 `Medication` → decoded R4 `Medication` (defaults the R4-only slots). */
const toR4 = (source: Type): typeof R4Medication.Schema.Type => ({
  ...R4Medication.empty,
  id: source.id,
  meta: source.meta,
  implicitRules: source.implicitRules,
  language: source.language,
  text: source.text,
  contained: source.contained,
  extension: source.extension,
  modifierExtension: source.modifierExtension,
  code: source.code,
  form: source.form,
})

/**
 * First R4-only field STU3 has no slot for, or `null` if the value is entirely
 * representable as STU3 and can round-trip.
 */
const unrepresentableField = (r4: typeof R4Medication.Schema.Type): string | null => {
  if (r4.identifier.length > 0) return 'Medication.identifier'
  if (r4.status !== null) return 'Medication.status'
  if (r4.manufacturer !== null) return 'Medication.manufacturer'
  if (r4.amount !== null) return 'Medication.amount'
  if (r4.ingredient.length > 0) return 'Medication.ingredient'
  if (r4.batch !== null) return 'Medication.batch'
  return null
}

/** Decoded R4 `Medication` → STU3 (representability already verified). */
const fromR4 = (r4: typeof R4Medication.Schema.Type): Type => ({
  resourceType: 'Medication',
  id: r4.id,
  meta: r4.meta,
  implicitRules: r4.implicitRules,
  language: r4.language,
  text: r4.text,
  contained: r4.contained,
  extension: r4.extension,
  modifierExtension: r4.modifierExtension,
  code: r4.code,
  form: r4.form,
})

/**
 * Decodes a carebook STU3 `Medication` wire payload straight to the fhir-r4
 * slice's decoded `Medication`. Encoding back to STU3 fails (via `ParseResult`)
 * when the R4 value carries data outside the STU3-representable subset.
 */
// Decoding through this fills the `optionalWith` defaults, so the encode
// callback can re-normalize the encoded side (absent optionals arrive as
// `undefined`) back to proper `null`s before inspecting fields.
const R4MedicationType = Schema.typeSchema(R4Medication.Schema)

const R4FromStu3Schema: Schema.Schema<
  typeof R4Medication.Schema.Type,
  typeof MedicationStruct.Encoded,
  never
> = Schema.transformOrFail(MedicationSchema, R4MedicationType, {
  strict: true,
  decode: (source) => ParseResult.succeed(toR4(source)),
  encode: (r4Raw, _options, ast) => {
    const r4 = Schema.decodeSync(R4MedicationType)(r4Raw)
    const field = unrepresentableField(r4)
    return field === null
      ? ParseResult.succeed(fromR4(r4))
      : ParseResult.fail(new ParseResult.Type(ast, r4, `${field} has no STU3 representation`))
  },
})

export { MedicationSchema as Schema, R4FromStu3Schema, type Type }
