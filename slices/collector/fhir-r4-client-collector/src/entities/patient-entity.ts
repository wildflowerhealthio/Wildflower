import { EntityDefinition, UrlMatch } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'

import { extractJson } from '../extract-json.ts'
import { withSourceIdentity } from '../source-identity.ts'

type PatientType = typeof Patient.Schema.Type

const decode = Schema.decode(Schema.parseJson(Patient.Schema))

/** `…://host/Patient/<id>` with optional query string, no further path. */
const patientUrl = UrlMatch.make({ segments: [UrlMatch.literal('Patient'), UrlMatch.id] })

/**
 * Entity for a single FHIR R4 `Patient` resource fetched at
 * `…/Patient/:id?…`. The response body the handler captures is either
 * the raw JSON (XHR intercept) or the mobile WebView's HTML JSON-viewer
 * wrapper around it; {@link extractJson} normalizes both. On a successful
 * decode it emits the resource as a single-element array; follow-up
 * navigation (Observation list) is declared on the slice's
 * `ScrapingPlan.stepSequence`, not emitted from `parse`.
 *
 * The emitted `Patient` is re-keyed onto the store's own namespace by
 * {@link withSourceIdentity} — its `id` derived from the server's, the
 * server's kept as an `Identifier`. That is what makes an `Observation`'s
 * `subject: 'Patient/<id>'` from the same server still name *this* resource.
 */
const PatientEntity: EntityDefinition.EntityDefinition<PatientType> = EntityDefinition.make({
  name: 'PatientEntity',
  isFoundAt: (url) => patientUrl.test(url),
  parse: (response) =>
    Effect.gen(function* () {
      const patient = yield* decode(extractJson(response.text()))
      if (patient.id === null) return []
      const withId: PatientType = { ...patient, id: patient.id }
      return yield* withSourceIdentity(response.url, 'instance', Patient.Schema.ast, [withId])
    }),
})

export { PatientEntity }
