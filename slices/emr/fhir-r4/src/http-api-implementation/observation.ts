import { HttpApiError } from '@effect/platform'
import { Effect, pipe } from 'effect'
import { domainResources, EmrStore, Observation as StoreObservation } from 'emr-core/livestore'
import { Commit } from 'emr-core/telemetry'

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
      pipe(
        EmrStore,
        Effect.flatMap((store) =>
          Effect.try({
            try: () =>
              store.commit(
                {
                  label: Commit.Upsert(domainResources.Observation.resourceType),
                  skipRefresh: true,
                },
                domainResources.Observation.events.upsert({ resource })
              ),
            catch: (err): unknown => err,
          })
        ),
        Effect.tapError((err: unknown) =>
          Effect.logError('Failed to commit Observation upsert', err)
        ),
        Effect.mapError(() => new HttpApiError.ServiceUnavailable())
      ),
    queryGetById$: domainResources.Observation.queries.getById$,
    querySearch$: domainResources.Observation.queries.search$,
    queryCount$: domainResources.Observation.queries.count$,
  }
)

export { layer }
