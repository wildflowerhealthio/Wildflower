import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Bundle } from '@wildflowerhealthio/fhir-r4/data-types'
import { Observation } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponseKind, UrlMatch } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Schema } from 'effect'

import * as FhirServerResponseKind from '../fhir-server-response-kind.ts'

const ObservationBundle = Bundle.Schema(Observation.Schema)
const decode = Schema.decode(Schema.parseJson(ObservationBundle))
const isObservation = Schema.is(Observation.Schema)

/**
 * `…://host/Observation?…`. The `mustHaveQuery` boundary keeps the
 * list pattern disjoint from `ObservationResponseKind` (`/Observation/<id>`),
 * so order in the source's response kinds is not load-bearing.
 */
const observationListUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('Observation')],
  end: 'mustHaveQuery',
})

/**
 * A FHIR R4 `Observation` search, `…/Observation?…`: the searchset's
 * Observations. An entry with no resource (a search-outcome or
 * request/response-only entry) is dropped, and the drop counted with
 * `Effect.logInfo`.
 */
const ObservationListResponseKind: HttpResponseKind.HttpResponseKind<
  DetachedResource.Detached<typeof Observation.Schema.Type>
> = FhirServerResponseKind.make({
  name: 'ObservationListResponseKind',
  url: observationListUrl,
  records: (body) =>
    Effect.gen(function* () {
      const bundle = yield* decode(body)
      const allEntries = bundle.entry ?? []
      const resources = allEntries.map(({ resource }) => resource).filter((o) => isObservation(o))
      const droppedCount = allEntries.length - resources.length
      if (droppedCount > 0) {
        yield* Effect.logInfo(
          `ObservationListResponseKind: dropped ${droppedCount} of ${allEntries.length} Bundle entries that did not decode as Observation`
        )
      }
      return resources
    }),
})

export { ObservationListResponseKind }
