import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import type { Schemas } from 'apps-core/http-api-definition'
import { Effect, Layer, type Schema } from 'effect'
import type { EffectAction } from 'react-kitchen-sink'
import { webHttpClientLayer } from 'telemetry-react'

import { useAppsAdminEffectAction, useAppsEffectAction } from './apps-client.tsx'

type AppEntry = Schema.Schema.Type<typeof Schemas.AppEntrySchema>
type CreateCustomAppPayload = Schema.Schema.Type<typeof Schemas.CreateCustomAppBodySchema>
type UpdateAppPayload = Schema.Schema.Type<typeof Schemas.UpdateAppBodySchema>

/**
 * Runner type for the public apps client — a `<A, E>(effect) => Promise<A>`
 * bound to the {@link AppsHttpApiClient} layer. The in-React form comes
 * from `useAppsEffectAction()`; the loader uses {@link runAppsPublicEffect},
 * which is bound to the same layer outside React.
 */
type AppsPublicEffectAction = EffectAction<AppsHttpApiClient>

/**
 * Query key for {@link appsListQueryOptions}. Mutations
 * ({@link useAppsAdminUpdateMutation}, {@link useAppsAdminCreateMutation},
 * {@link useAppsAdminDeleteMutation}) invalidate this key on success so
 * the next render re-fetches. Persisting the cache via TanStack Query's
 * localStorage persister keys the snapshot here too.
 */
const APPS_LIST_QUERY_KEY = ['apps', 'list'] as const

/**
 * The public `AppsHttpApiClient` is tokenless (`authType: 'none'`), so
 * its layer carries no React-derived state — it's a static composition
 * of the client layer plus the shared web `HttpClient` layer. That lets
 * the route `loader` (which runs *outside* React, so it can't call
 * `useAppsEffectAction`) run the exact same `ListApps` effect the hook
 * runs, against the same layer, by piping through {@link runAppsPublicEffect}.
 */
const appsPublicLayer = AppsHttpApiClient.layer.pipe(Layer.provideMerge(webHttpClientLayer))

/**
 * Run a public-apps-client effect outside React against
 * {@link appsPublicLayer}. Used by the route `loader` to prefetch the
 * apps list via `queryClient.ensureQueryData(appsListQueryOptions(...))`.
 * Mirrors the `useAppsEffectAction()` runner used inside the component,
 * so loader and hook resolve the identical request.
 */
const runAppsPublicEffect: AppsPublicEffectAction = (effect) =>
  Effect.runPromise(effect.pipe(Effect.provide(appsPublicLayer), Effect.scoped))

/**
 * Shared TanStack Query options for the public `ListApps` endpoint,
 * parameterised over the effect `run`ner so the same `queryKey` +
 * `queryFn` pairing is consumed two ways:
 *
 *   - the route `loader` calls `queryClient.ensureQueryData(...)` with
 *     `appsListQueryOptions(runAppsPublicEffect)` to prefetch before the
 *     screen mounts (blocking navigation until the data resolves);
 *   - {@link useAppsListQuery} calls `useSuspenseQuery(...)` with
 *     `appsListQueryOptions(useAppsEffectAction())`, which then resolves
 *     instantly from the cache the loader just populated.
 *
 * The query stays in cache (and is persisted) across reloads; with
 * `staleTime: 0` on the global `QueryClient`, a remount fires a
 * background refetch that swaps in fresh data once the request returns.
 */
// The `queryOptions` helper's return type carries a branded `queryKey`
// and is generic over four type parameters; re-expressing it as an
// explicit annotation would be both unwieldy and fragile across
// `@tanstack/react-query` versions. Inferring it keeps the single source
// of truth in the library, matching how `defineSliceReact` (and the other
// `defineSlice*` factories) leave their derived returns inferred. The
// inferred shape is consumed by both `useSuspenseQuery` (in
// {@link useAppsListQuery}) and `queryClient.ensureQueryData` (in the
// route loader), so it's exercised end-to-end by the slice's tests.
// oxlint-disable-next-line typescript/explicit-function-return-type
const appsListQueryOptions = (run: AppsPublicEffectAction) =>
  queryOptions({
    queryKey: APPS_LIST_QUERY_KEY,
    queryFn: () => run(Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps())),
  })

/**
 * Suspense-backed read of the public `ListApps` endpoint via the shared
 * {@link appsListQueryOptions}. Paired with the route `loader`, which
 * prefetches the same options, so this hook resolves from cache without
 * suspending after the loader has run.
 */
const useAppsListQuery = (): UseSuspenseQueryResult<readonly AppEntry[], Error> => {
  const run = useAppsEffectAction()
  return useSuspenseQuery(appsListQueryOptions(run))
}

/**
 * Admin `UpdateApp` (PATCH /apps/:id). Invalidates {@link APPS_LIST_QUERY_KEY}
 * on success.
 */
const useAppsAdminUpdateMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly payload: UpdateAppPayload }
> => {
  const run = useAppsAdminEffectAction()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) =>
      run(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].UpdateApp({ path: { id }, payload })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/**
 * Admin `CreateCustomApp` (POST /apps). Invalidates
 * {@link APPS_LIST_QUERY_KEY} on success.
 */
const useAppsAdminCreateMutation = (): UseMutationResult<
  unknown,
  Error,
  CreateCustomAppPayload
> => {
  const run = useAppsAdminEffectAction()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) =>
      run(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].CreateCustomApp({ payload }))
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/**
 * Admin `DeleteApp` (DELETE /apps/:id). Invalidates
 * {@link APPS_LIST_QUERY_KEY} on success.
 */
const useAppsAdminDeleteMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string }
> => {
  const run = useAppsAdminEffectAction()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) =>
      run(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].DeleteApp({ path: { id } }))
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

export {
  APPS_LIST_QUERY_KEY,
  appsListQueryOptions,
  runAppsPublicEffect,
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useAppsAdminUpdateMutation,
  useAppsListQuery,
}
export type { AppEntry, AppsPublicEffectAction, CreateCustomAppPayload, UpdateAppPayload }
