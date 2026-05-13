import { EntityDefinition, UrlMatch } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Bundle } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'

import { extractJson } from '../extract-json.ts'

type ObservationType = typeof Observation.Schema.Type

const ObservationBundle = Bundle.Schema(Observation.Schema)
const decode = Schema.decode(Schema.parseJson(ObservationBundle))
const isObservation = Schema.is(Observation.Schema)

/**
 * `…://host/Observation?…`. The `mustHaveQuery` boundary keeps the
 * list pattern disjoint from `ObservationEntity` (`/Observation/<id>`),
 * so order in `ScrapingPlan.entityDefinitions` is no longer
 * load-bearing.
 */
const observationListUrl = UrlMatch.make({
  segments: [UrlMatch.literal('Observation')],
  end: 'mustHaveQuery',
})

/**
 * Entity for a FHIR R4 `Bundle` of `Observation` resources fetched at
 * `…/Observation?…`. Extracts the entries whose `resource` decodes as a
 * full `Observation` and drops the rest (the Bundle schema is
 * permissive about `entry.resource` so we re-check here). The dropped
 * count is surfaced via `Effect.logInfo` so partial-decode losses
 * aren't invisible at runtime. {@link extractJson} normalizes the body
 * across raw-JSON XHR intercepts and the mobile WebView's JSON viewer
 * wrap.
 */
const ObservationListEntity: EntityDefinition.EntityDefinition<ObservationType> =
  EntityDefinition.make({
    name: 'ObservationListEntity',
    isFoundAt: (url) => observationListUrl.test(url),
    parse: (response) =>
      Effect.gen(function* () {
        const bundle = yield* decode(extractJson(response.text()))
        const allEntries = bundle.entry ?? []
        const resources = allEntries.map(({ resource }) => resource).filter((o) => isObservation(o))
        const droppedCount = allEntries.length - resources.length
        if (droppedCount > 0) {
          yield* Effect.logInfo(
            `ObservationListEntity: dropped ${droppedCount} of ${allEntries.length} Bundle entries that did not decode as Observation`
          )
        }
        return resources
      }),
  })

export { ObservationListEntity }
