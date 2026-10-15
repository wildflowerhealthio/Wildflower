import { ParseResult, Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import {
  BackboneElement,
  CodeableConcept,
  DomainResource,
  IdentifierAndReference,
  Ratio,
} from '@wildflowerhealthio/fhir-r4/data-types'
import type { MedicationIngredient as R4MedicationIngredient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  Medication as R4Medication,
  MedicationBatch as R4MedicationBatch,
} from '@wildflowerhealthio/fhir-r4/resources'

/**
 * FHIR STU3 `Medication.status` value set: active | inactive | entered-in-error.
 * Identical members to R4, so it maps through unchanged.
 */
const StatusSchema = Schema.Literal('active', 'inactive', 'entered-in-error')

/**
 * STU3 `Medication.ingredient` — a constituent of the medication. Same shape as
 * R4's `Medication.ingredient` except the quantity slot: STU3 calls it `amount`
 * where R4 calls it `strength` (both a `Ratio`). `item[x]` is modelled as two
 * nullable fields, lenient about which is present, matching the R4 schema.
 */
const IngredientStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    itemCodeableConcept: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
    itemReference: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
    isActive: OrNullAsOptional(Schema.Boolean),
    amount: OrNullAsOptional(Schema.suspend(() => Ratio.Schema)),
  })
)

type IngredientType = typeof IngredientStruct.Type

const IngredientSchema: Schema.Schema<IngredientType, typeof IngredientStruct.Encoded, never> =
  IngredientStruct

/**
 * STU3 `Medication.package`, modelled down to its `batch` array. A
 * `package.batch` entry (`lotNumber`, `expirationDate`) has the same wire shape
 * as R4's `Medication.batch`, so it reuses the fhir-r4 schema. STU3's
 * `package.container` and `package.content` have no R4 slot and are not
 * modelled (ignored on decode).
 */
const PackageStruct = mutableEncoded(
  StructNoContext({
    ...BackboneElement.fields,
    batch: Schema.optionalWith(mutableEncoded(Schema.Array(R4MedicationBatch.Schema)), {
      default: (): readonly (typeof R4MedicationBatch.Schema.Type)[] => [],
    }),
  })
)

type PackageType = typeof PackageStruct.Type

const PackageSchema: Schema.Schema<PackageType, typeof PackageStruct.Encoded, never> = PackageStruct

/**
 * Just-enough STU3 `Medication`, as it appears in `MedicationRequest.contained`.
 * Models `code`, `status`, `manufacturer`, `form`, `ingredient`, `package`
 * (down to `package.batch`), and the DomainResource extension array (where the
 * dialect places `strength` / `description`). Unknown fields are ignored on
 * decode (Effect's default excess-property behaviour), keeping the schema
 * lenient per the epic's scope.
 *
 * {@link R4FromStu3Schema} maps `ingredient[].amount` ⇄ R4 `ingredient[].strength`
 * and `package.batch[0]` ⇄ R4 `batch`; the other shared fields map through
 * unchanged. R4 `identifier` and `amount` have no STU3 slot.
 */
const MedicationStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Medication') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      code: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      status: OrNullAsOptional(StatusSchema),
      manufacturer: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      form: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      ingredient: Schema.optionalWith(mutableEncoded(Schema.Array(IngredientSchema)), {
        default: (): readonly IngredientType[] => [],
      }),
      package: OrNullAsOptional(PackageSchema),
    })
  )
)

type Type = typeof MedicationStruct.Type

const MedicationSchema: Schema.Schema<Type, typeof MedicationStruct.Encoded, never> =
  MedicationStruct

// --- ingredient / batch transforms --------------------------------------------

/** STU3 ingredient → decoded R4 ingredient (`amount` → `strength`). */
const ingredientToR4 = (ingredient: IngredientType): typeof R4MedicationIngredient.Schema.Type => ({
  id: ingredient.id,
  extension: ingredient.extension,
  modifierExtension: ingredient.modifierExtension,
  itemCodeableConcept: ingredient.itemCodeableConcept,
  itemReference: ingredient.itemReference,
  isActive: ingredient.isActive,
  strength: ingredient.amount,
})

/** Decoded R4 ingredient → STU3 ingredient (`strength` → `amount`). */
const ingredientFromR4 = (
  ingredient: typeof R4MedicationIngredient.Schema.Type
): IngredientType => ({
  id: ingredient.id,
  extension: ingredient.extension,
  modifierExtension: ingredient.modifierExtension,
  itemCodeableConcept: ingredient.itemCodeableConcept,
  itemReference: ingredient.itemReference,
  isActive: ingredient.isActive,
  amount: ingredient.strength,
})

/**
 * STU3 `package` → R4 `batch`: the first `package.batch` entry. R4 holds one
 * batch, so later batches are dropped, as is the package backbone's own
 * `id` / extensions (R4 has no package element to carry them).
 */
const batchToR4 = (pkg: PackageType | null): typeof R4MedicationBatch.Schema.Type | null =>
  pkg?.batch[0] ?? null

/** R4 `batch` → STU3 `package` holding that one batch, or no package. */
const packageFromR4 = (batch: typeof R4MedicationBatch.Schema.Type | null): PackageType | null =>
  batch === null ? null : { id: null, extension: [], modifierExtension: [], batch: [batch] }

// --- Medication transform -------------------------------------------------------

/** STU3 `Medication` → decoded R4 `Medication` (defaults the unmodelled slots). */
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
  status: source.status,
  manufacturer: source.manufacturer,
  form: source.form,
  ingredient: source.ingredient.map(ingredientToR4),
  batch: batchToR4(source.package),
})

/**
 * First R4-only field STU3 has no slot for, or `null` if the value is entirely
 * representable as STU3 and can round-trip.
 */
const unrepresentableField = (r4: typeof R4Medication.Schema.Type): string | null => {
  if (r4.identifier.length > 0) return 'Medication.identifier'
  if (r4.amount !== null) return 'Medication.amount'
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
  status: r4.status,
  manufacturer: r4.manufacturer,
  form: r4.form,
  ingredient: r4.ingredient.map(ingredientFromR4),
  package: packageFromR4(r4.batch),
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

export {
  IngredientSchema,
  MedicationSchema as Schema,
  PackageSchema,
  R4FromStu3Schema,
  StatusSchema,
  type IngredientType,
  type PackageType,
  type Type,
}
