import { Array as Arr, Schema } from 'effect'

/**
 * A FHIR `Patient` narrowed to what a picker shows and binds: its `id`, its
 * names, its birth date and its gender, read leniently from any FHIR server.
 *
 * @remarks
 * A namespace module — consumers speak `PatientMinimal.Schema` and
 * `PatientMinimal.Type` (from `@wildflowerhealthio/fhir-r4/patient-minimal`).
 *
 * It imports nothing but `effect`: no datatype schema, so no datatype
 * registry, which a page with a size budget (the authorization server's
 * consent card) cannot carry. It is lenient where `Patient.Schema` is strict,
 * because a picker lists whatever server it reads, and one record's oddity
 * must not cost it the record:
 *
 * - each name decodes on its own, and a name that doesn't read is left out;
 * - `given`'s `null` placeholders (a part carrying only an extension) are
 *   dropped;
 * - `birthDate` is the string the server wrote, a partial date (`1970`,
 *   `1970-05`) included;
 * - every field but `id` may be absent or `null`.
 *
 * A name keeps exactly the fields `displayName` reads, so a patient's names go
 * straight to it.
 *
 * @packageDocumentation
 */

/**
 * `HumanName.given` with FHIR's `null` placeholders dropped. A JSON array may
 * hold `null` where a part has only an extension (paired with `_given`); the
 * name the display rule renders is the parts that are there.
 */
const PatientMinimalGivenSchema = Schema.transform(
  Schema.Array(Schema.NullOr(Schema.String)),
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (givenParts) => givenParts.filter((part): part is string => part !== null),
    encode: (givenParts) => givenParts,
  }
)

/** A `HumanName` as loosely as the display rule reads it. */
const PatientMinimalNameSchema = Schema.Struct({
  use: Schema.optional(Schema.NullOr(Schema.String)),
  given: Schema.optional(Schema.NullOr(PatientMinimalGivenSchema)),
  family: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  period: Schema.optional(
    Schema.NullOr(Schema.Struct({ end: Schema.optional(Schema.NullOr(Schema.String)) }))
  ),
})

const decodePatientMinimalName = Schema.decodeUnknownOption(PatientMinimalNameSchema)

/**
 * A record's names, each decoded on its own: a name that does not read as a
 * {@link PatientMinimalNameSchema} is left out, and the patient keeps the rest.
 */
const PatientMinimalNamesSchema = Schema.transform(
  Schema.Array(Schema.Unknown),
  Schema.Array(Schema.typeSchema(PatientMinimalNameSchema)),
  {
    strict: true,
    decode: (names) => Arr.filterMap(names, (name) => decodePatientMinimalName(name)),
    encode: (names) => names,
  }
)

/** FHIR's `AdministrativeGender` codes. */
const PatientMinimalGenderSchema = Schema.Literal('male', 'female', 'other', 'unknown')

const PatientMinimalSchema = Schema.Struct({
  resourceType: Schema.Literal('Patient'),
  /** The patient's logical id: what a pick binds. */
  id: Schema.NonEmptyString,
  /** The record's readable names in record order; `[]` when it has none. */
  name: Schema.optionalWith(PatientMinimalNamesSchema, { nullable: true, default: () => [] }),
  /** The birth date as the server wrote it (`1815-12-10`, `1815-12`, `1815`); `null` when absent. */
  birthDate: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  /** The patient's administrative gender; `null` when absent. */
  gender: Schema.optionalWith(Schema.NullOr(PatientMinimalGenderSchema), {
    default: () => null,
  }),
})

/** A patient as {@link PatientMinimalSchema} reads it. */
type PatientMinimal = typeof PatientMinimalSchema.Type

export { PatientMinimalSchema as Schema }
export type { PatientMinimal as Type }
