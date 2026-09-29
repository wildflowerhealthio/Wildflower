import { Schema } from 'effect'

/**
 * An optional profile string, decoded to an `Option`. A blank one is still
 * `Some("")` here — the profile sends `""` for a name it holds no value for —
 * so a reader filters blanks out where it reads the field.
 */
const OptionalProfileString = Schema.optionalWith(Schema.String, { as: 'Option' })

/**
 * The body of the carebook profile at `…/enduser/profile/v2/me` (bespoke JSON,
 * not FHIR), in the shape of `fixtures/profile-me.json`.
 *
 * @remarks
 * `ProfileResponseKind` decodes it into an R4 `Patient`, so the decode is
 * lenient: only `data.identifiers.uid` (the `Patient.id` every medication's
 * `subject` references) is required, every other field is optional, and
 * unmodelled keys are ignored. Field names are reconciled against a real
 * capture — note the non-obvious nesting (`data.names`, top-level
 * `data.zipPostalCode`); since the decode is lenient, a wrong path silently
 * leaves `Patient.name` / `Patient.address` empty rather than failing.
 *
 * `createdOn` / `updatedOn` arrive in `CarebookTimestamp`'s form. They
 * decode as plain strings: the `Patient` reads neither, so a timestamp in some
 * other form must not fail the profile.
 */
const CarebookProfile = Schema.Struct({
  data: Schema.Struct({
    identifiers: Schema.Struct({
      uid: Schema.String,
      email: OptionalProfileString,
      reportingGuid: OptionalProfileString,
    }),
    names: Schema.optionalWith(
      Schema.Struct({ firstName: OptionalProfileString, lastName: OptionalProfileString }),
      { as: 'Option' }
    ),
    birthDate: OptionalProfileString,
    zipPostalCode: OptionalProfileString,
    /** `Validated` in the capture. */
    accountState: OptionalProfileString,
    createdOn: OptionalProfileString,
    updatedOn: OptionalProfileString,
  }),
  /** Linked profiles; empty in the capture, so its entries are unmodelled. */
  related: Schema.optionalWith(Schema.Struct({ profiles: Schema.Array(Schema.Unknown) }), {
    as: 'Option',
  }),
})

export { CarebookProfile }
