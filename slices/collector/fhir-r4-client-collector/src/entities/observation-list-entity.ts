import { EntityDefinition } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Bundle } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'

type ObservationType = typeof Observation.Schema.Type

const ObservationBundle = Bundle.Schema(Observation.Schema)
const decode = Schema.decode(Schema.parseJson(ObservationBundle))
const isObservation = Schema.is(Observation.Schema)

/**
 * Entity for a FHIR R4 `Bundle` of `Observation` resources fetched at
 * `…/Observation?…`. Extracts the entries whose `resource` decodes as a
 * full `Observation` and drops the rest (the Bundle schema is
 * permissive about `entry.resource` so we re-check here). The dropped
 * count is surfaced via `Effect.logInfo` so partial-decode losses
 * aren't invisible at runtime.
 *
 * `isFoundAt` requires a `?` immediately after `/Observation` so the
 * list URL is disjoint from `ObservationEntity` (`/Observation/:id`).
 * Order in `Remote.entityDefinitions` is therefore no longer
 * load-bearing.
 */
const ObservationListEntity: EntityDefinition.EntityDefinition<ObservationType> =
  EntityDefinition.make({
    name: 'ObservationListEntity',
    isFoundAt: (url) => /:\/\/[^/]+\/Observation\?/.test(url),
    parse: (response) =>
      Effect.gen(function* () {
        const bundle = yield* decode(response.text())
        const allEntries = bundle.entry ?? []
        const resources = allEntries.map(({ resource }) => resource).filter((o) => isObservation(o))
        const droppedCount = allEntries.length - resources.length
        if (droppedCount > 0) {
          yield* Effect.logInfo(
            `ObservationListEntity: dropped ${droppedCount} of ${allEntries.length} Bundle entries that did not decode as Observation`
          )
        }
        return { resources, links: [] }
      }),
  })

export { ObservationListEntity }
