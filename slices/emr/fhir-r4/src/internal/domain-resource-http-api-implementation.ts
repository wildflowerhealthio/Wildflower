import {
  HttpApi,
  HttpApiBuilder,
  HttpApiError,
  type HttpApiGroup,
  HttpServerRequest,
} from '@effect/platform'
import type { Queryable, State } from '@livestore/livestore'
import { Effect, type Layer, Schema } from 'effect'
import { EmrStore } from 'emr-core/livestore'
import { Bundle as StoreBundle } from 'emr-core/schemas'
import { type Origin, requestOriginFromHttpRequest } from 'navigation-core'

import { withMandatoryId } from '../data-types/with-mandatory-id.ts'
import { FhirResourcesApiPrefix } from '../http-api-definition/index.ts'
import { buildDomainResourceHttpApiGroup } from './domain-resource-http-api-definition.ts'
import { decodePageToken, encodePageToken } from './page-token.ts'
import type { BaseSearchParams, SearchParamBindings } from './search-param-bindings.ts'

/**
 * Build the per-resource handler `Layer` for the group produced by
 * {@link buildDomainResourceHttpApiGroup}. Handlers invoke the supplied
 * livestore `Queryable`s and `commitUpsert` callback against the
 * `EmrStore` context — no repository layer.
 *
 *  - `SearchByGet` → GET /:resourceType/?...   livestore search$ + count$, Bundle
 *  - `Search`      → POST /:resourceType/_search (form body), same handler core
 *  - `GetById`     → `store.query(queryGetById$(id))`, 404 on miss
 *  - `Create`      → `commitUpsert(payload)`
 *  - `Update`      → `commitUpsert({ ...payload, id })`
 *
 * Pagination is opaque-cursor based via `_pageToken` (encoded `{ offset, count }`).
 * Clients follow `Bundle.link[rel=next/previous].url`; they do not construct
 * offset URLs themselves. Garbled tokens are treated as "no token" (lenient).
 */
export function makeDomainResourceHandlerLayer<
  const RT extends 'Observation' | 'Patient' | 'Binary',
  const StoreType extends { readonly id: string | null; readonly resourceType: RT },
  const StoreEncoded extends { readonly id: string | null; readonly resourceType: RT },
  const FhirType extends { id?: string | undefined; readonly resourceType: RT },
  const SearchParamsType extends BaseSearchParams,
  const Table extends State.SQLite.TableDefBase,
>(
  resourceType: RT,
  rowSchema: Schema.Schema<StoreType, StoreEncoded, never>,
  fhirSchema: Schema.Schema<StoreType, FhirType, never>,
  searchBindings: SearchParamBindings<SearchParamsType, Table>,
  bindings: {
    commitUpsert: (
      resource: StoreType & { readonly id: string }
    ) => Effect.Effect<void, HttpApiError.ServiceUnavailable, EmrStore>
    queryGetById$: (id: string) => Queryable<(StoreType & { readonly id: string }) | undefined>
    querySearch$: (params: {
      readonly where?: ReturnType<SearchParamBindings<SearchParamsType, Table>['buildWhere']>
      readonly limit?: number
      readonly offset?: number
    }) => Queryable<readonly (StoreType & { readonly id: string })[]>
    queryCount$: (params: {
      readonly where?: ReturnType<SearchParamBindings<SearchParamsType, Table>['buildWhere']>
    }) => Queryable<number>
    /**
     * Optional hook for `$everything`: produce resources related to the primary
     * resource (e.g. a Patient's Observations). Returns `[]` when not provided,
     * so the bundle contains only the primary resource.
     */
    getRelated?: (params: {
      readonly id: string
      readonly limit: number | undefined
    }) => Effect.Effect<
      ReadonlyArray<{ readonly resourceType: string; readonly id: string }>,
      HttpApiError.ServiceUnavailable,
      EmrStore
    >
  }
): Layer.Layer<HttpApiGroup.ApiGroup<'FhirResourcesApi', RT>, never, EmrStore | Origin> {
  type ResourceWithId = StoreType & { readonly id: string }

  const storeSchemaWithId = withMandatoryId(rowSchema)

  const httpApiGroup = buildDomainResourceHttpApiGroup(
    resourceType,
    fhirSchema,
    searchBindings.SearchParams
  )
  const localApi = HttpApi.make('FhirResourcesApi').add(httpApiGroup).prefix(FhirResourcesApiPrefix)

  const bundleSchema = StoreBundle.Schema(storeSchemaWithId)
  const bundleEntrySchema = StoreBundle.EntrySchema(storeSchemaWithId)
  const everythingBundleSchema = StoreBundle.Schema(Schema.Any)
  const everythingEntrySchema = StoreBundle.EntrySchema(Schema.Any)

  const DEFAULT_PAGE_SIZE = 10

  const resourceFullUrl = (origin: string, type: string, id: string): URL =>
    new URL(`${FhirResourcesApiPrefix}/${type}/${id}`, origin)

  const buildSearchsetBundle = (
    origin: string,
    resources: readonly ResourceWithId[],
    total: number,
    link: ReadonlyArray<{ readonly relation: string; readonly url: string }>
  ): Effect.Effect<Schema.Schema.Type<typeof bundleSchema>, HttpApiError.ServiceUnavailable> =>
    Effect.try({
      try: () =>
        bundleSchema.make({
          resourceType: 'Bundle',
          id: null,
          meta: null,
          implicitRules: null,
          language: null,
          type: 'searchset',
          identifier: null,
          link: link.map((l) => ({
            id: null,
            extension: [],
            modifierExtension: [],
            relation: l.relation,
            url: l.url,
          })),
          signature: null,
          timestamp: null,
          total,
          entry: resources.map((resource) =>
            bundleEntrySchema.make({
              id: null,
              extension: [],
              modifierExtension: [],
              fullUrl: resourceFullUrl(origin, resource.resourceType, resource.id),
              link: [],
              request: null,
              resource: resource,
              response: null,
              search: {
                id: null,
                extension: [],
                modifierExtension: [],
                mode: 'match',
                score: null,
              },
            })
          ),
        }),
      catch: () => new HttpApiError.ServiceUnavailable(),
    }).pipe(
      Effect.withSpan('fhir.buildSearchsetBundle', {
        attributes: {
          resourceType,
          resourceCount: resources.length,
          total,
          linkCount: link.length,
        },
      })
    )

  const cursorUrl = (
    requestUrl: URL,
    payload: { readonly offset: number; readonly count: number }
  ): string => {
    const u = new URL(requestUrl.toString())
    u.searchParams.delete('_pageToken')
    u.searchParams.set('_pageToken', encodePageToken(payload))
    return u.toString()
  }

  const paginationLinks = (
    requestUrl: URL,
    limit: number,
    offset: number,
    total: number
  ): ReadonlyArray<{ readonly relation: string; readonly url: string }> => {
    const links: { readonly relation: string; readonly url: string }[] = [
      { relation: 'self', url: requestUrl.toString() },
    ]
    if (offset + limit < total) {
      links.push({
        relation: 'next',
        url: cursorUrl(requestUrl, { offset: offset + limit, count: limit }),
      })
    }
    if (offset > 0) {
      links.push({
        relation: 'previous',
        url: cursorUrl(requestUrl, { offset: Math.max(0, offset - limit), count: limit }),
      })
    }
    return links
  }

  const runSearch = (
    params: SearchParamsType
  ): Effect.Effect<
    Schema.Schema.Type<typeof bundleSchema>,
    HttpApiError.ServiceUnavailable,
    EmrStore | Origin | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const origin = yield* requestOriginFromHttpRequest
      const requestUrl = new URL(req.url, origin)
      const where = searchBindings.buildWhere(params)
      const requestedCount = params._count ?? DEFAULT_PAGE_SIZE
      let decoded: ReturnType<typeof decodePageToken> | undefined = undefined
      if (params._pageToken !== undefined) {
        decoded = decodePageToken(params._pageToken)
      }
      const offset = decoded?.offset ?? 0
      const limit = decoded?.count ?? requestedCount
      const store = yield* EmrStore
      const rows = yield* Effect.try({
        try: () => store.query(bindings.querySearch$({ where, limit, offset })),
        catch: () => new HttpApiError.ServiceUnavailable(),
      }).pipe(
        Effect.withSpan('fhir.runSearch.querySearch', {
          attributes: { resourceType, limit, offset, hasWhere: where !== undefined },
        })
      )
      const total = yield* Effect.try({
        try: () => store.query(bindings.queryCount$({ where })),
        catch: () => new HttpApiError.ServiceUnavailable(),
      }).pipe(
        Effect.withSpan('fhir.runSearch.queryCount', {
          attributes: { resourceType, hasWhere: where !== undefined },
        })
      )
      return yield* buildSearchsetBundle(
        origin,
        rows,
        total,
        paginationLinks(requestUrl, limit, offset, total)
      )
    }).pipe(
      Effect.withSpan('fhir.runSearch', {
        attributes: {
          resourceType,
          hasPageToken: params._pageToken !== undefined,
          requestedCount: params._count ?? DEFAULT_PAGE_SIZE,
        },
      })
    )

  const upsertAndFetch = (
    resource: ResourceWithId
  ): Effect.Effect<ResourceWithId, HttpApiError.ServiceUnavailable, EmrStore> =>
    bindings
      .commitUpsert(resource)
      .pipe(
        Effect.withSpan('fhir.upsertAndFetch.commitUpsert', {
          attributes: { resourceType, id: resource.id },
        })
      )
      .pipe(
        Effect.flatMap(() =>
          Effect.flatMap(EmrStore, (store) =>
            Effect.try({
              try: () => store.query(bindings.queryGetById$(resource.id)),
              catch: () => new HttpApiError.ServiceUnavailable(),
            }).pipe(
              Effect.withSpan('fhir.upsertAndFetch.queryGetById', {
                attributes: { resourceType, id: resource.id },
              })
            )
          )
        ),
        Effect.flatMap((fetched) => {
          if (fetched === undefined) {
            return Effect.fail(new HttpApiError.ServiceUnavailable())
          }
          return Effect.succeed(fetched)
        }),
        Effect.withSpan('fhir.upsertAndFetch', {
          attributes: { resourceType, id: resource.id },
        })
      )

  // `HttpApiBuilder.group` against a generically-built group cannot recover
  // the precise per-endpoint request shape — `request` arrives typed as the
  // union of every endpoint's request, so each handler narrows it back down
  // to the schema declared in `domain-resource-http-api-definition.ts`
  // (which is the source of truth and what the runtime decodes against).
  // The casts below are this narrowing; they are sound by construction
  // because the definition and implementation are derived from the same
  // generic parameters in this file. CLAUDE.md exception 4 (technical
  // foundation code) applies; tests in
  // `tests/{patient,binary,observation}-endpoint.test.ts` exercise each
  // handler.
  return HttpApiBuilder.group(localApi, resourceType, (handlers) =>
    handlers
      .handle('SearchByGet', (request) => {
        /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
        const { urlParams } = request as { readonly urlParams: SearchParamsType }
        return runSearch(urlParams).pipe(
          Effect.withSpan('fhir.SearchByGet', { attributes: { resourceType } })
        )
      })
      .handle('Search', (request) => {
        console.log('Search handler received request:', request)
        /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
        const { payload } = request as { readonly payload: SearchParamsType }
        return runSearch(payload).pipe(
          Effect.withSpan('fhir.Search', { attributes: { resourceType } })
        )
      })
      .handle('GetById', ({ path: { id } }) =>
        Effect.flatMap(EmrStore, (store) =>
          Effect.try({
            try: () => store.query(bindings.queryGetById$(id)),
            catch: () => new HttpApiError.ServiceUnavailable(),
          }).pipe(
            Effect.withSpan('fhir.GetById.queryGetById', {
              attributes: { resourceType, id },
            }),
            Effect.flatMap((resource) => {
              if (resource === undefined) {
                return Effect.fail(new HttpApiError.NotFound())
              }
              return Effect.succeed(resource)
            })
          )
        ).pipe(Effect.withSpan('fhir.GetById', { attributes: { resourceType, id } }))
      )
      .handle('Create', (request) => {
        /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
        const { payload } = request as { readonly payload: ResourceWithId }
        return upsertAndFetch(payload).pipe(
          Effect.withSpan('fhir.Create', { attributes: { resourceType, id: payload.id } })
        )
      })
      .handle('Update', (request) => {
        /* oxlint-disable-next-line typescript/no-unsafe-type-assertion */
        const { path, payload } = request as {
          readonly path: { readonly id: string }
          readonly payload: StoreType
        }
        return upsertAndFetch({ ...payload, id: path.id }).pipe(
          Effect.withSpan('fhir.Update', { attributes: { resourceType, id: path.id } })
        )
      })
      .handle('Everything', (request) => {
        const { path, urlParams } = request as {
          readonly path: { readonly id: string }
          readonly urlParams: { readonly _count?: number | undefined }
        }
        const { id } = path
        const limit = urlParams._count
        return Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest
          const origin = yield* requestOriginFromHttpRequest
          const requestUrl = new URL(req.url, origin)
          const store = yield* EmrStore
          const primary = yield* Effect.try({
            try: () => store.query(bindings.queryGetById$(id)),
            catch: () => new HttpApiError.ServiceUnavailable(),
          }).pipe(
            Effect.withSpan('fhir.Everything.queryGetById', {
              attributes: { resourceType, id },
            })
          )
          if (primary === undefined) {
            return yield* Effect.fail(new HttpApiError.NotFound())
          }
          let related: ReadonlyArray<{ readonly resourceType: string; readonly id: string }> = []
          if (bindings.getRelated !== undefined) {
            related = yield* bindings.getRelated({ id, limit }).pipe(
              Effect.withSpan('fhir.Everything.getRelated', {
                attributes: { resourceType, id, limit: limit ?? -1 },
              })
            )
          }
          const entries: ReadonlyArray<{
            readonly resourceType: string
            readonly id: string
          }> = [primary, ...related]
          return everythingBundleSchema.make({
            resourceType: 'Bundle',
            id: null,
            meta: null,
            implicitRules: null,
            language: null,
            type: 'searchset',
            identifier: null,
            link: [
              {
                id: null,
                extension: [],
                modifierExtension: [],
                relation: 'self',
                url: requestUrl.toString(),
              },
            ],
            signature: null,
            timestamp: null,
            total: entries.length,
            entry: entries.map((resource) =>
              everythingEntrySchema.make({
                id: null,
                extension: [],
                modifierExtension: [],
                fullUrl: resourceFullUrl(origin, resource.resourceType, resource.id),
                link: [],
                request: null,
                resource,
                response: null,
                search: {
                  id: null,
                  extension: [],
                  modifierExtension: [],
                  mode: 'match',
                  score: null,
                },
              })
            ),
          })
        }).pipe(Effect.withSpan('fhir.Everything', { attributes: { resourceType, id } }))
      })
  )
}
