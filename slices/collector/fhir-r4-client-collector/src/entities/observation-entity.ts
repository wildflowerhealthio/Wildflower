import { EntityDefinition } from 'collector-core/model'
import { Effect, Schema } from 'effect'
import { Observation } from 'fhir-r4/resources'

type ObservationType = typeof Observation.Schema.Type

const decode = Schema.decode(Schema.parseJson(Observation.Schema))

/**
 * Entity for a single FHIR R4 `Observation` resource fetched at
 * `…/Observation/:id`. The wire schema lives in `fhir-r4/resources` —
 * its `Encoded` is the FHIR R4 wire JSON, its `Type` is the
 * emr-core-shaped row, so the decoded `resources` entry is ready to
 * persist without further mapping.
 *
 * `isFoundAt` matches `…/Observation/<id>` with an optional query
 * string but no further path segments — the `[^/?#]+` cluster
 * excludes path separators and query/fragment delimiters so a URL
 * like `…/Observation/123?_format=json` matches with `123` as the
 * effective id (compare the previous `[^/]+$` form which would
 * silently swallow the query string into the captured id).
 */
const ObservationEntity: EntityDefinition.EntityDefinition<ObservationType> = EntityDefinition.make(
  {
    name: 'ObservationEntity',
    isFoundAt: (url) => /:\/\/[^/]+\/Observation\/[^/?#]+(?:\?|$)/.test(url),
    parse: (response) =>
      Effect.map(decode(response.text()), (observation) => ({
        resources: [observation],
        links: [],
      })),
  }
)

export { ObservationEntity }
