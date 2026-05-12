import { EntityDefinition } from 'collector-core/model'
import { Effect, Schema } from 'effect'
import { Patient } from 'fhir-r4/resources'

type PatientType = typeof Patient.Schema.Type

const decode = Schema.decode(Schema.parseJson(Patient.Schema))

/**
 * Entity for a single FHIR R4 `Patient` resource fetched at
 * `…/Patient/:id?…`. On a successful decode it emits the resource and
 * a follow-up link to fetch a small set of vitals observations for
 * that patient (codes are LOINC 3141-9, 8302-2, 8287-5, 39156-5 —
 * weight, height, length, BMI). The link is empty when the parsed
 * `Patient.id` is null (no usable subject reference).
 *
 * `isFoundAt` matches `…/Patient/<id>` with an optional query string
 * but no further path segments — the `[^/?#]+` cluster keeps the id
 * portion clean (no `?_format=json` swallowed into the id), and the
 * `(?:\?|$)` boundary excludes URLs like `…/Patient/123/_history` or
 * trailing-slash variants.
 */
const PatientEntity: EntityDefinition.EntityDefinition<PatientType> = EntityDefinition.make({
  name: 'PatientEntity',
  isFoundAt: (url) => /:\/\/[^/]+\/Patient\/[^/?#]+(?:\?|$)/.test(url),
  parse: (response) =>
    Effect.map(decode(response.text()), (patient) => {
      if (patient.id === null) return { resources: [], links: [] }
      const withId: PatientType = { ...patient, id: patient.id }
      return {
        resources: [withId],
        links: [
          {
            _tag: 'Open' as const,
            href: `/Observation?subject%3APatient=${encodeURIComponent(patient.id)}&code=3141-9%2C8302-2%2C8287-5%2C39156-5&_count=50`,
          },
        ],
      }
    }),
})

export { PatientEntity }
