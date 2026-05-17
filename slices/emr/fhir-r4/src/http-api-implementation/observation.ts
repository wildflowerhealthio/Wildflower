import { HttpApiError } from '@effect/platform'
import { Effect } from 'effect'
import { EmrStore } from 'emr-core/contexts'
import { domainResources, Observation as StoreObservation } from 'emr-core/livestore'

import { makeDomainResourceHandlerLayer } from '../internal/domain-resource-http-api-implementation.ts'
import { Observation } from '../resources/observation/index.ts'
import {
  buildWhere as buildObservationWhere,
  SearchParams as ObservationSearchParams,
} from '../resources/observation/search-params.ts'

const layer = makeDomainResourceHandlerLayer(
  'Observation',
  StoreObservation.RowSchemaNullableId,
  Observation.Schema,
  { SearchParams: ObservationSearchParams, buildWhere: buildObservationWhere },
  {
    commitUpsert: (resource) =>
      Effect.flatMap(EmrStore, (store) =>
        Effect.try({
          try: () => store.commit(domainResources.Observation.events.upsert({ resource })),
          catch: () => new HttpApiError.ServiceUnavailable(),
        })
      ),
    queryGetById$: domainResources.Observation.queries.getById$,
    querySearch$: domainResources.Observation.queries.search$,
    queryCount$: domainResources.Observation.queries.count$,
  }
)

export { layer }
