import { Effect, Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'
import { HttpResponseKind, UrlMatch } from 'http-extraction-fundamentals'

import { extractJson } from '../extract-json.ts'
import { recognizeFhirRoot } from '../recognize-fhir-root.ts'

const decode = Schema.decode(Schema.parseJson(Observation.Schema))

/** `…://host/Observation/<id>` with optional query string, no further path. */
const observationUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('Observation'), UrlMatch.id],
})

/**
 * Entity for a single FHIR R4 `Observation` resource fetched at
 * `…/Observation/:id`. The wire schema lives in `fhir-r4/resources` —
 * its `Encoded` is the FHIR R4 wire JSON, its `Type` is the decoded
 * FHIR value, so the decoded array entry is ready to use without
 * further mapping. {@link extractJson} normalizes the body
 * across raw-JSON XHR intercepts and the mobile WebView's JSON viewer
 * wrap.
 */
const ObservationResponseKind: HttpResponseKind.HttpResponseKind<Observation.Type> =
  HttpResponseKind.make({
    name: 'ObservationResponseKind',
    tryRecognize: recognizeFhirRoot(observationUrl),
    parse: (response) =>
      Effect.map(decode(extractJson(response.text())), (observation) => [observation]),
  })

export { ObservationResponseKind }
