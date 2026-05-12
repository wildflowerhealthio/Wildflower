import { EntityDefinition } from 'collector-core/model'
import { Either, Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'

type ObservationType = typeof Observation.Schema.Type

const decode = Schema.decodeEither(Schema.parseJson(Observation.Schema))

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
    isFoundAt: (url) => /.*:\/\/[^/]*\/Observation\/[^/]+$/.test(url),
    parse: (response) =>
      decode(response.text()).pipe(
        Either.map((observation) => ({ resources: [observation], links: [] }))
      ),
  }
)

export { ObservationEntity }
