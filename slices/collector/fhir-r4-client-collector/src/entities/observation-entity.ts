import { EntityDefinition, UrlMatch } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'

type ObservationType = typeof Observation.Schema.Type

const decode = Schema.decode(Schema.parseJson(Observation.Schema))

/** `…://host/Observation/<id>` with optional query string, no further path. */
const observationUrl = UrlMatch.make({ segments: [UrlMatch.literal('Observation'), UrlMatch.id] })

/**
 * Entity for a single FHIR R4 `Observation` resource fetched at
 * `…/Observation/:id`. The wire schema lives in `fhir-r4/resources` —
 * its `Encoded` is the FHIR R4 wire JSON, its `Type` is the
 * emr-core-shaped row, so the decoded `resources` entry is ready to
 * persist without further mapping.
 */
const ObservationEntity: EntityDefinition.EntityDefinition<ObservationType> = EntityDefinition.make(
  {
    name: 'ObservationEntity',
    isFoundAt: (url) => observationUrl.test(url),
    parse: (response) =>
      Effect.map(decode(response.text()), (observation) => ({
        resources: [observation],
        links: [],
      })),
  }
)

export { ObservationEntity }
