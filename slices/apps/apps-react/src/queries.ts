import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import type { Schemas } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'

import { useAppsAdminEffectAction, useAppsEffectAction } from './apps-client.tsx'

type AppEntry = Schema.Schema.Type<typeof Schemas.AppEntrySchema>
type CreateCustomAppPayload = Schema.Schema.Type<typeof Schemas.CreateCustomAppBodySchema>
type UpdateAppPayload = Schema.Schema.Type<typeof Schemas.UpdateAppBodySchema>

/**
 * Query key for {@link useAppsListQuery}. Mutations
 * ({@link useAppsAdminUpdateMutation}, {@link useAppsAdminCreateMutation},
 * {@link useAppsAdminDeleteMutation}) invalidate this key on success so
 * the next render re-fetches. Persisting the cache via TanStack Query's
 * localStorage persister keys the snapshot here too.
 */
const APPS_LIST_QUERY_KEY = ['apps', 'list'] as const

/**
 * Suspense-backed read of the public `ListApps` endpoint. The query
 * stays in cache (and is persisted) across reloads; with `staleTime: 0`
 * on the global `QueryClient`, the first render after a remount fires a
 * background refetch that swaps in fresh data once the request returns.
 */
const useAppsListQuery = (): UseSuspenseQueryResult<readonly AppEntry[], Error> => {
  const run = useAppsEffectAction()
  return useSuspenseQuery({
    queryKey: APPS_LIST_QUERY_KEY,
    queryFn: () => run(Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps())),
  })
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
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useAppsAdminUpdateMutation,
  useAppsListQuery,
}
export type { AppEntry, CreateCustomAppPayload, UpdateAppPayload }
