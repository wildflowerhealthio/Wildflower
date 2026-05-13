import { EntityDefinition, UrlMatch } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'

import { extractJson } from '../extract-json.ts'

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
 * `ScrapingPlan.linkSequence`, not emitted from `parse`.
 */
const PatientEntity: EntityDefinition.EntityDefinition<PatientType> = EntityDefinition.make({
  name: 'PatientEntity',
  isFoundAt: (url) => patientUrl.test(url),
  parse: (response) =>
    Effect.map(decode(extractJson(response.text())), (patient) => {
      if (patient.id === null) return []
      const withId: PatientType = { ...patient, id: patient.id }
      return [withId]
    }),
})

export { PatientEntity }
