import { Effect, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'
import {
  HttpResponseKind,
  extractJson,
  recognizePortal,
  UrlMatch,
} from 'http-extraction-fundamentals'
import { nonEmpty } from 'kitchen-sink'
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'

type PatientType = typeof Patient.Schema.Type

/**
 * Just-enough schema for the carebook profile payload the Rexall SPA fetches at
 * `…/enduser/profile/v2/me`. This response is a bespoke carebook JSON shape, **not
 * FHIR**, so it does not go through `fhir-stu3-as-r4`; it is decoded here and then
 * synthesized into an R4 `Patient`.
 *
 * The payload nests everything under a top-level `data` envelope. Only
 * `data.identifiers.uid` is required — it is the id every medication's `subject`
 * references, so it becomes the synthesized `Patient.id`. Everything else is
 * optional and lenient (unknown fields are dropped on decode, Effect's default),
 * so a field the capture omits simply leaves its Patient slot at the schema
 * default rather than failing the decode.
 *
 * @remarks
 * The field names here are reconciled against a real (anonymized) capture. Note
 * that the name and postal-code paths are **not** the flat ones you would
 * expect: names are nested under `data.names`, and the postal code is a
 * top-level `data.zipPostalCode` rather than an `address` sub-object. Because
 * the decode is deliberately lenient, getting these wrong does not fail — it
 * silently leaves `Patient.name` and `Patient.address` empty, which is exactly
 * what happened before the capture arrived.
 *
 * Fields the payload also carries and this schema deliberately ignores:
 * `identifiers.reportingGuid`, `accountState`, `createdOn` / `updatedOn`, and
 * the top-level `related.profiles` array (dependants, empty in the capture).
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
 * Build the FHIR R4 `Patient` **wire** object from the decoded carebook profile,
 * emitting a field only when the source carries it (so an absent name/DOB/etc.
 * leaves the corresponding R4 slot at its schema default rather than a synthetic
 * empty). The result is decoded through `Patient.Schema` so it lands as a proper
 * decoded R4 value — matching how `PatientResponseKind` decodes a wire Patient.
 *
 * `nonEmpty` is what makes "absent" and "blank" one case: the carebook profile
 * sends `""` for a name it holds no value for, which would otherwise synthesize
 * a `Patient.name` entry of empty strings.
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

/** `…://host/…/profile/v2/me` — the carebook patient-identity endpoint. */
const profileUrl = UrlMatch.make({
  segments: [UrlMatch.literal('profile'), UrlMatch.literal('v2'), UrlMatch.literal('me')],
})

/**
 * Response kind for the carebook profile response (`…/enduser/profile/v2/me`). `parse`
 * decodes the bespoke (non-FHIR) profile JSON and **synthesizes an R4 Patient**:
 * `id = identifiers.uid` (the `subject` every medication references), plus
 * birthDate, postal-code address, email telecom, and name when the profile
 * carries them. Follow-up navigation (the prescriptions page) is declared on the
 * plan's `stepSequence`, not emitted here. {@link extractJson} normalizes the
 * body across raw-XHR intercepts and the mobile WebView's JSON-viewer wrap.
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
