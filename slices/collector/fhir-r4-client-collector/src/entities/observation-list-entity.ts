import { EntityDefinition } from 'collector-core/model'
import { Either, Schema } from 'effect'
import { Bundle } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'

type ObservationType = typeof Observation.Schema.Type

const ObservationBundle = Bundle.Schema(Observation.Schema)
const decode = Schema.decodeEither(Schema.parseJson(ObservationBundle))
const isObservation = Schema.is(Observation.Schema)

/**
 * Entity for a FHIR R4 `Bundle` of `Observation` resources fetched at
 * `…/Observation?…`. Extracts the entries whose `resource` decodes as a
 * full `Observation` and drops the rest (the Bundle schema is
 * permissive about `entry.resource` so we re-check here).
 */
const ObservationListEntity: EntityDefinition.EntityDefinition<ObservationType> =
  EntityDefinition.make({
    name: 'ObservationListEntity',
    isFoundAt: (url) => /.*:\/\/[^/]*\/Observation.*$/.test(url),
    parse: (response) =>
      decode(response.text()).pipe(
        Either.map((bundle) => ({
          resources:
            bundle.entry?.map(({ resource }) => resource).filter((o) => isObservation(o)) ?? [],
          links: [],
        }))
      ),
  })

export { ObservationListEntity }
