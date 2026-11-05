import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Observation } from '@wildflowerhealthio/fhir-r4/resources'
import { type HttpResponseKind, UrlMatch } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Schema } from 'effect'

import * as FhirServerResponseKind from '../fhir-server-response-kind.ts'

const decode = Schema.decode(Schema.parseJson(Observation.Schema))

/** `…://host/Observation/<id>` with optional query string, no further path. */
const observationUrl = UrlMatch.make({
  verb: ['GET'],
  segments: [UrlMatch.literal('Observation'), UrlMatch.id],
})

/** A FHIR R4 `Observation` read, `…/Observation/<id>`: the one Observation. */
const ObservationResponseKind: HttpResponseKind.HttpResponseKind<
  DetachedResource.Detached<typeof Observation.Schema.Type>
> = FhirServerResponseKind.make({
  name: 'ObservationResponseKind',
  url: observationUrl,
  readRecords: (body) => Effect.map(decode(body), (observation) => [observation]),
})

export { ObservationResponseKind }
