import { Effect, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'
import { nonEmpty } from 'kitchen-sink'
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'

type PatientType = typeof Patient.Schema.Type

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
    identifiers: Schema.Struct({ uid: Schema.String, email: Schema.optional(Schema.String) }),
    names: Schema.optional(
      Schema.Struct({
        firstName: Schema.optional(Schema.String),
        lastName: Schema.optional(Schema.String),
      })
    ),
    birthDate: Schema.optional(Schema.String),
    zipPostalCode: Schema.optional(Schema.String),
  }),
})

type Profile = typeof ProfileSchema.Type

const decodeProfile = Schema.decode(Schema.parseJson(ProfileSchema))
const decodePatient = Schema.decodeUnknown(Patient.Schema)

/**
 * Build the FHIR R4 `Patient` **wire** from the decoded profile, emitting a
 * field only when the source carries it. `nonEmpty` collapses "absent" and
 * "blank" — the profile sends `""` for a name it holds no value for.
 */
const patientWire = (profile: Profile): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id: profile.data.identifiers.uid,
  }
  const family = nonEmpty(profile.data.names?.lastName)
  const given = nonEmpty(profile.data.names?.firstName)
  if (family !== null || given !== null) {
    wire['name'] = [
      {
        ...(family !== null ? { family } : {}),
        ...(given !== null ? { given: [given] } : {}),
      },
    ]
  }
  const birthDate = nonEmpty(profile.data.birthDate)
  if (birthDate !== null) wire['birthDate'] = birthDate
  const email = nonEmpty(profile.data.identifiers.email)
  if (email !== null) wire['telecom'] = [{ system: 'email', value: email }]
  const postalCode = nonEmpty(profile.data.zipPostalCode)
  if (postalCode !== null) wire['address'] = [{ postalCode }]
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
