import { HttpApiError } from '@effect/platform'
import { Effect } from 'effect'
import { LivestoreStore } from 'emr-core/contexts'
import { domainResources, Binary as StoreBinary } from 'emr-core/livestore'

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
      Effect.flatMap(LivestoreStore, (store) =>
        Effect.try({
          try: () => store.commit(domainResources.Binary.events.upsert({ resource })),
          catch: () => new HttpApiError.ServiceUnavailable(),
        })
      ),
    queryGetById$: domainResources.Binary.queries.getById$,
    querySearch$: domainResources.Binary.queries.search$,
    queryCount$: domainResources.Binary.queries.count$,
  }
)

export { layer }
