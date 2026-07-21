import { EntityDefinition, UrlMatch } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'

import { extractJson } from '../extract-json.ts'

type PatientType = typeof Patient.Schema.Type

/**
 * Just-enough schema for the carebook profile payload the Rexall SPA fetches at
 * `…/enduser/profile/v2/me`. This response is a bespoke carebook JSON shape, **not
 * FHIR**, so it does not go through `fhir-stu3-as-r4`; it is decoded here and then
 * synthesized into an R4 `Patient`.
 *
 * Only `identifiers.uid` is required — it is the id every medication's `subject`
 * references, so it becomes the synthesized `Patient.id`. Everything else is
 * optional and lenient (unknown fields are dropped on decode, Effect's default).
 *
 * ⚠️ The exact field names below (`firstName` / `lastName` / `dateOfBirth` /
 * `email` / `address.postalCode`) are **synthesized from the epic notes, not a
 * real capture** — an open question on issue #339. Reconcile them against a
 * redacted `/me` capture before relying on the synthesized demographics; a
 * name/DOB/address the capture spells differently simply won't populate until the
 * field name here matches (decode never fails on the mismatch, it just drops it).
 */
const ProfileSchema = Schema.Struct({
  data: Schema.Struct({
    identifiers: Schema.Struct({ uid: Schema.String, email: Schema.optional(Schema.String) }),
    firstName: Schema.optional(Schema.String),
    lastName: Schema.optional(Schema.String),
    birthDate: Schema.optional(Schema.String),
    address: Schema.optional(Schema.Struct({ postalCode: Schema.optional(Schema.String) })),
  }),
})

type Profile = typeof ProfileSchema.Type

const decodeProfile = Schema.decode(Schema.parseJson(ProfileSchema))
const decodePatient = Schema.decodeUnknown(Patient.Schema)

/**
 * Build the FHIR R4 `Patient` **wire** object from the decoded carebook profile,
 * emitting a field only when the source carries it (so an absent name/DOB/etc.
 * leaves the corresponding R4 slot at its schema default rather than a synthetic
 * empty). The result is decoded through `Patient.Schema` so it lands as a proper
 * decoded R4 value — matching how `PatientEntity` decodes a wire Patient.
 */
const patientWire = (profile: Profile): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id: profile.data.identifiers.uid,
  }
  if (profile.data.firstName != null || profile.data.lastName != null) {
    wire['name'] = [
      {
        ...(profile.data.lastName != null ? { family: profile.data.lastName } : {}),
        ...(profile.data.firstName != null ? { given: [profile.data.firstName] } : {}),
      },
    ]
  }
  if (profile.data.birthDate != null) wire['birthDate'] = profile.data.birthDate
  if (profile.data.identifiers.email != null)
    wire['telecom'] = [{ system: 'email', value: profile.data.identifiers.email }]
  const postalCode = profile.data.address?.postalCode
  if (postalCode != null) wire['address'] = [{ postalCode }]
  return wire
}

/** `…://host/…/profile/v2/me` — the carebook patient-identity endpoint. */
const profileUrl = UrlMatch.make({
  segments: [UrlMatch.literal('profile'), UrlMatch.literal('v2'), UrlMatch.literal('me')],
})

/**
 * Entity for the carebook profile response (`…/enduser/profile/v2/me`). `parse`
 * decodes the bespoke (non-FHIR) profile JSON and **synthesizes an R4 Patient**:
 * `id = identifiers.uid` (the `subject` every medication references), plus
 * birthDate, postal-code address, email telecom, and name when the profile
 * carries them. Follow-up navigation (the prescriptions page) is declared on the
 * plan's `stepSequence`, not emitted here. {@link extractJson} normalizes the
 * body across raw-XHR intercepts and the mobile WebView's JSON-viewer wrap.
 */
const ProfileEntity: EntityDefinition.EntityDefinition<PatientType> = EntityDefinition.make({
  name: 'ProfileEntity',
  isFoundAt: (url) => profileUrl.test(url),
  parse: (response) =>
    Effect.gen(function* () {
      const profile = yield* decodeProfile(extractJson(response.text()))
      const patient = yield* decodePatient(patientWire(profile))
      return [patient]
    }),
})

export { ProfileEntity, ProfileSchema }
