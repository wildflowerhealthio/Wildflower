import { Effect, Option, pipe, Schema, String as Str } from 'effect'
import { Patient } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'

type PatientType = typeof Patient.Schema.Type

/**
 * An optional profile string, decoded to an `Option`. A blank one is still
 * `Some("")` here — the profile sends `""` for a name it holds no value for —
 * so a reader filters blanks out where it reads the field.
 */
const OptionalProfileString = Schema.optionalWith(Schema.String, { as: 'Option' })

/**
 * Just-enough schema for the bespoke (non-FHIR) carebook profile payload at
 * `…/enduser/profile/v2/me`, synthesized here into an R4 `Patient`. Only
 * `data.identifiers.uid` (the `Patient.id` every medication's `subject`
 * references) is required; the rest is optional and lenient. Field names are
 * reconciled against a real capture — note the non-obvious nesting (`data.names`,
 * top-level `data.zipPostalCode`); since the decode is lenient, a wrong path
 * silently leaves `Patient.name` / `Patient.address` empty rather than failing.
 */
const ProfileSchema = Schema.Struct({
  data: Schema.Struct({
    identifiers: Schema.Struct({ uid: Schema.String, email: OptionalProfileString }),
    names: Schema.optionalWith(
      Schema.Struct({ firstName: OptionalProfileString, lastName: OptionalProfileString }),
      { as: 'Option' }
    ),
    birthDate: OptionalProfileString,
    zipPostalCode: OptionalProfileString,
  }),
})

type Profile = typeof ProfileSchema.Type

const decodeProfile = Schema.decode(Schema.parseJson(ProfileSchema))
const decodePatient = Schema.decodeUnknown(Patient.Schema)

/** A profile name's part, when the profile carries a non-blank one. */
const namePartOf = (
  names: Profile['data']['names'],
  part: 'firstName' | 'lastName'
): Option.Option<string> =>
  pipe(
    names,
    Option.flatMap((profileNames) => profileNames[part]),
    Option.filter(Str.isNonEmpty)
  )

/**
 * Build the FHIR R4 `Patient` **wire** from the decoded profile, emitting a
 * field only when the source carries it. A blank string counts as absent — the
 * profile sends `""` for a name it holds no value for.
 */
const patientWire = (profile: Profile): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id: profile.data.identifiers.uid,
  }
  const family = namePartOf(profile.data.names, 'lastName')
  const given = namePartOf(profile.data.names, 'firstName')
  if (Option.isSome(family) || Option.isSome(given)) {
    wire['name'] = [
      {
        ...(Option.isSome(family) ? { family: family.value } : {}),
        ...(Option.isSome(given) ? { given: [given.value] } : {}),
      },
    ]
  }
  const birthDate = Option.filter(profile.data.birthDate, Str.isNonEmpty)
  if (Option.isSome(birthDate)) wire['birthDate'] = birthDate.value
  const email = Option.filter(profile.data.identifiers.email, Str.isNonEmpty)
  if (Option.isSome(email)) wire['telecom'] = [{ system: 'email', value: email.value }]
  const postalCode = Option.filter(profile.data.zipPostalCode, Str.isNonEmpty)
  if (Option.isSome(postalCode)) wire['address'] = [{ postalCode: postalCode.value }]
  return wire
}

/**
 * The exact profile-identity XHR URL, anchored and pinned to host + full
 * `/enduser/profile/v2/me` path with an optional query. Only the query varies.
 */
const profileUrl = /^https:\/\/rexall-prd-tunnel\.letsbewell\.ca\/enduser\/profile\/v2\/me(?:\?|$)/

/**
 * Response kind for the carebook profile response: decodes the bespoke JSON and
 * synthesizes an R4 `Patient` (`id = identifiers.uid`, plus name/DOB/address/email
 * when present).
 */
const ProfileResponseKind: HttpResponseKind.HttpResponseKind<PatientType> = HttpResponseKind.make({
  name: 'ProfileResponseKind',
  tryRecognize: recognizePortal(profileUrl, REXALL_CAREBOOK_SYSTEM),
  parse: (response) =>
    Effect.gen(function* () {
      const profile = yield* decodeProfile(extractJson(response.text()))
      const patient = yield* decodePatient(patientWire(profile))
      return [patient]
    }),
})

export { ProfileResponseKind, ProfileSchema }
