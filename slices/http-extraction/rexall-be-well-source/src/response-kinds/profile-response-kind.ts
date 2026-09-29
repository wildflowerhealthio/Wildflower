import { Effect, Option, RegExp as EffectRegExp, pipe, Schema, String as Str } from 'effect'
import { Patient } from 'fhir-r4/resources'
import { HttpResponseKind, extractJson, recognizePortal } from 'http-extraction-fundamentals'
import { CarebookProfile } from '../carebook-profile.ts'
import { REXALL_CAREBOOK_SYSTEM } from '../source-system.ts'
import { REXALL_PROFILE_URL } from '../tunnel-url.ts'

type PatientType = typeof Patient.Schema.Type

/**
 * The part of {@link CarebookProfile} the `Patient` is built from. Decoding
 * only these fields keeps every field the `Patient` does not read — the
 * timestamps, `accountState`, `reportingGuid`, `related` — from failing a
 * profile, whatever shape a capture sends it in.
 */
const PatientProfile = Schema.Struct({
  data: Schema.Struct({
    ...CarebookProfile.fields.data.pick('names', 'birthDate', 'zipPostalCode').fields,
    identifiers: CarebookProfile.fields.data.fields.identifiers.pick('uid', 'email'),
  }),
})

type Profile = typeof PatientProfile.Type

const decodeProfile = Schema.decode(Schema.parseJson(PatientProfile))
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
 * {@link REXALL_PROFILE_URL} exactly, anchored and pinned to host + full
 * `/enduser/profile/v2/me` path with an optional query. Only the query varies.
 */
const profileUrl = new RegExp(`^${EffectRegExp.escape(REXALL_PROFILE_URL)}(?:\\?|$)`)

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

export { ProfileResponseKind }
