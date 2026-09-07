import { Effect, Schema } from 'effect'
import { Bundle } from 'fhir-r4/data-types'
import { Observation } from 'fhir-r4/resources'
import { HttpResponseKind, UrlMatch } from 'http-extraction-fundamentals'

import { extractJson } from '../extract-json.ts'
import { recognizeFhirRoot } from '../recognize-fhir-root.ts'

type ObservationType = typeof Observation.Schema.Type

const ObservationBundle = Bundle.Schema(Observation.Schema)
const decode = Schema.decode(Schema.parseJson(ObservationBundle))
const isObservation = Schema.is(Observation.Schema)

/**
 * `…://host/Observation?…`. The `mustHaveQuery` boundary keeps the
 * list pattern disjoint from `ObservationResponseKind` (`/Observation/<id>`),
 * so order in the `ScrapingPlan` response kinds is no longer
 * load-bearing.
 */
const observationListUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('Observation')],
  end: 'mustHaveQuery',
})

/**
 * Entity for a FHIR R4 `Bundle` of `Observation` resources fetched at
 * `…/Observation?…`. The Bundle schema decodes each `entry.resource` as
 * `Observation | null` (`OrNullAsOptional`), so entries with no resource
 * (search-outcome or request/response-only entries) survive decode as
 * `null`; the `isObservation` filter drops those `null`s and keeps only
 * present `Observation` resources. The dropped count is surfaced via
 * `Effect.logInfo` so those losses aren't invisible at runtime.
 * {@link extractJson} normalizes the body
 * across raw-JSON XHR intercepts and the mobile WebView's JSON viewer
 * wrap.
 */
const ObservationListResponseKind: HttpResponseKind.HttpResponseKind<ObservationType> =
  HttpResponseKind.make({
    name: 'ObservationListResponseKind',
    tryRecognize: recognizeFhirRoot(observationListUrl),
    parse: (response) =>
      Effect.gen(function* () {
        const bundle = yield* decode(extractJson(response.text()))
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
