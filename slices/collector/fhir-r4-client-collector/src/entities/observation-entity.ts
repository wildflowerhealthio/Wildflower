import { EntityDefinition, UrlMatch } from 'collector-fundamentals/model'
import { Effect, Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'

import { extractJson } from '../extract-json.ts'
import { withSourceIdentity } from '../source-identity.ts'

type ObservationType = typeof Observation.Schema.Type

const decode = Schema.decode(Schema.parseJson(Observation.Schema))

/** `…://host/Observation/<id>` with optional query string, no further path. */
const observationUrl = UrlMatch.make({ segments: [UrlMatch.literal('Observation'), UrlMatch.id] })

/**
 * Entity for a single FHIR R4 `Observation` resource fetched at
 * `…/Observation/:id`. The wire schema lives in `fhir-r4/resources` —
 * its `Encoded` is the FHIR R4 wire JSON, its `Type` is the decoded
 * FHIR value, so the decoded array entry is ready to use without
 * further mapping. {@link extractJson} normalizes the body
 * across raw-JSON XHR intercepts and the mobile WebView's JSON viewer
 * wrap.
 *
 * {@link withSourceIdentity} then re-keys it onto the store's namespace —
 * including its `subject`, so the link to the `Patient` this collector stored
 * survives the re-key.
 */
const ObservationEntity: EntityDefinition.EntityDefinition<ObservationType> = EntityDefinition.make(
  {
    name: 'ObservationEntity',
    isFoundAt: (url) => observationUrl.test(url),
    parse: (response) =>
      Effect.gen(function* () {
        const observation = yield* decode(extractJson(response.text()))
        return yield* withSourceIdentity(response.url, 'instance', Observation.Schema.ast, [
          observation,
        ])
      }),
  }
)

export { ObservationEntity }
