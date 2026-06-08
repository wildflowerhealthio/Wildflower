import { HttpApiError } from '@effect/platform'
import { Effect, pipe } from 'effect'
import { Binary as StoreBinary, domainResources, EmrStore } from 'emr-core/livestore'
import { Commit } from 'emr-core/telemetry'

import { makeDomainResourceHandlerLayer } from '../internal/domain-resource-http-api-implementation.ts'
import { Binary } from '../resources/binary/index.ts'
import {
  buildWhere as buildBinaryWhere,
  SearchParams as BinarySearchParams,
} from '../resources/binary/search-params.ts'

const layer = makeDomainResourceHandlerLayer(
  'Binary',
  StoreBinary.RowSchemaNullableId,
  Binary.Schema,
  { SearchParams: BinarySearchParams, buildWhere: buildBinaryWhere },
  {
    commitUpsert: (resource) =>
      pipe(
        EmrStore,
        Effect.flatMap((store) =>
          Effect.try({
            try: () =>
              store.commit(
                {
                  label: Commit.Upsert(domainResources.Binary.resourceType),
                  skipRefresh: true,
                },
                domainResources.Binary.events.upsert({ resource })
              ),
            catch: (err): unknown => err,
          })
        ),
        Effect.tapError((err: unknown) => Effect.logError('Failed to commit Binary upsert', err)),
        Effect.mapError(() => new HttpApiError.ServiceUnavailable())
      ),
    queryGetById$: domainResources.Binary.queries.getById$,
    querySearch$: domainResources.Binary.queries.search$,
    queryCount$: domainResources.Binary.queries.count$,
  }
)

export { layer }
