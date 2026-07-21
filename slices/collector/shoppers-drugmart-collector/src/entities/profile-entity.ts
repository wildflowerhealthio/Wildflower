import { EntityDefinition } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'

import { extractJson } from '../extract-json.ts'
import { ShoppersIdentifierSystem } from '../shoppers.ts'

type PatientType = typeof Patient.Schema.Type

/**
 * Just-enough schema for the profile payload the Shoppers SPA fetches at
 * `…/api/profile/getProfile/` when the health dashboard loads. This response is
 * a bespoke portal JSON shape, **not FHIR**, so it is decoded here and then
 * synthesized into an R4 `Patient`.
 *
 * Only the top-level `pcId` is required — it becomes the synthesized
 * `Patient.id`. Everything under `profile` is optional and lenient (unknown
 * fields are dropped on decode, Effect's default), so a field the capture omits
 * simply leaves its Patient slot at the schema default rather than failing the
 * decode.
 *
 * **`pcId` is not the prescriptions' `patientId`.** The prescription
 * `…/prescription-status` payloads reference a different `patientId`, so this
 * Patient (keyed by `pcId`, carrying the demographics) is a *separate* record
 * from the minimal Patient the prescription entity synthesizes (keyed by
 * `patientId`, the id `MedicationRequest.subject` resolves to). Each carries its
 * own id as a FHIR identifier so the two can be reconciled later. Joining them
 * into one record isn't possible here: entities parse each XHR independently,
 * with no shared state and no join key between the two ids.
 */
const ProfileSchema = Schema.Struct({
  pcId: Schema.String,
  profile: Schema.optional(
    Schema.Struct({
      firstName: Schema.optional(Schema.String),
      lastName: Schema.optional(Schema.String),
      dateOfBirth: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
      phone: Schema.optional(Schema.String),
      address: Schema.optional(
        Schema.Struct({
          streetAddress1: Schema.optional(Schema.String),
          streetAddress2: Schema.optional(Schema.String),
          city: Schema.optional(Schema.String),
          province: Schema.optional(Schema.String),
          postalCode: Schema.optional(Schema.String),
          country: Schema.optional(Schema.String),
        })
      ),
    })
  ),
})

type Profile = typeof ProfileSchema.Type

const decodeProfile = Schema.decode(Schema.parseJson(ProfileSchema))
const decodePatient = Schema.decodeUnknown(Patient.Schema)

/** `YYYY-MM-DD` prefix of a date/date-time string, or `undefined` if it isn't one. */
const asBirthDate = (value: string | undefined): string | undefined => {
  if (value == null) return undefined
  const date = value.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
}

/**
 * Build the FHIR R4 `Patient` **wire** object from the decoded profile, emitting
 * a field only when the source carries it (so an absent name/DOB/etc. leaves the
 * corresponding R4 slot at its schema default rather than a synthetic empty).
 * The result is decoded through `Patient.Schema` so it lands as a proper decoded
 * R4 value.
 */
const patientWire = (profile: Profile): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    resourceType: 'Patient',
    id: profile.pcId,
    identifier: [{ system: ShoppersIdentifierSystem.PcId, value: profile.pcId }],
  }
  const p = profile.profile
  if (p == null) return wire

  if (p.firstName != null || p.lastName != null) {
    wire['name'] = [
      {
        ...(p.lastName != null ? { family: p.lastName } : {}),
        ...(p.firstName != null ? { given: [p.firstName] } : {}),
      },
    ]
  }

  const birthDate = asBirthDate(p.dateOfBirth)
  if (birthDate != null) wire['birthDate'] = birthDate

  const telecom: Array<Record<string, unknown>> = []
  if (p.email != null) telecom.push({ system: 'email', value: p.email })
  if (p.phone != null) telecom.push({ system: 'phone', value: p.phone })
  if (telecom.length > 0) wire['telecom'] = telecom

  if (p.address != null) {
    const line = [p.address.streetAddress1, p.address.streetAddress2].filter(
      (l): l is string => l != null && l.length > 0
    )
    const address: Record<string, unknown> = {}
    if (line.length > 0) address['line'] = line
    if (p.address.city != null) address['city'] = p.address.city
    if (p.address.province != null) address['state'] = p.address.province
    if (p.address.postalCode != null) address['postalCode'] = p.address.postalCode
    if (p.address.country != null) address['country'] = p.address.country
    if (Object.keys(address).length > 0) wire['address'] = [address]
  }

  return wire
}

/** `…://host/…/profile/getProfile/` — the portal's profile-identity endpoint. */
const profileUrl = /:\/\/[^/]+(?:\/[^/?#]+)*?\/profile\/getProfile\/?(?:[?#]|$)/

/**
 * Entity for the Shoppers profile response (`…/api/profile/getProfile/`). `parse`
 * decodes the bespoke (non-FHIR) profile JSON and **synthesizes an R4 Patient**:
 * `id = pcId`, plus name, birthDate, email/phone telecom, and postal address
 * when the profile carries them, with `pcId` recorded as an identifier.
 *
 * The recognizer is a hand-rolled regex (not `UrlMatch.make`) because the real
 * endpoint carries a **trailing slash** (`…/getProfile/`), which the segment DSL's
 * `pathEnd` boundary can't express. It mirrors the DSL's leading `://host` +
 * optional-base-path convention and tolerates an optional trailing slash / query.
 * {@link extractJson} normalizes the body across raw-XHR intercepts and the
 * mobile WebView's JSON-viewer wrap.
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
