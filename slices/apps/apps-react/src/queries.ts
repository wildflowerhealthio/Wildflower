import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core/clients'
import type { Schemas } from 'apps-core/http-api-definition'
import { Effect, type Schema } from 'effect'

import type { RouterContext, RunAuthed } from './router-context.ts'

// Annotated `select` so the result stays typed when the slice's router
// isn't registered (standalone build).
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

/**
 * Catalogue row as it arrives from `GET /apps`. The launch URL is
 * deliberately NOT exposed here — clients launch by POSTing to `/apps/:id`
 * and following the redirect (see {@link Schemas.AppListEntrySchema}).
 */
type AppEntry = Schema.Schema.Type<typeof Schemas.AppListEntrySchema>
type CreateAppPayload = Schema.Schema.Type<typeof Schemas.CreateAppBodySchema>
type UpdateAppPayload = Schema.Schema.Type<typeof Schemas.UpdateAppBodySchema>
type PlacementPayload = Schema.Schema.Type<typeof Schemas.PlacementBodySchema>

/** Mutations invalidate this key on success so the next render refetches. */
const APPS_LIST_QUERY_KEY = ['apps', 'list'] as const

/** Shared by route `loader` (`ensureQueryData`) and {@link useAppsListQuery}. */
const appsListQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<
  readonly AppEntry[],
  Error,
  readonly AppEntry[],
  typeof APPS_LIST_QUERY_KEY
> =>
  queryOptions({
    queryKey: APPS_LIST_QUERY_KEY,
    queryFn: () => runAuthed(Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps())),
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useAppsListQuery = (): UseSuspenseQueryResult<readonly AppEntry[], Error> =>
  useSuspenseQuery(appsListQueryOptions(useRunAuthed()))

/** Admin `UpdateApp` (PATCH /apps/:id). Invalidates {@link APPS_LIST_QUERY_KEY}. */
const useAppsAdminUpdateMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly payload: UpdateAppPayload }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].UpdateApp({ path: { id }, payload })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/** Admin `CreateApp` (POST /apps). Invalidates {@link APPS_LIST_QUERY_KEY}. */
const useAppsAdminCreateMutation = (): UseMutationResult<unknown, Error, CreateAppPayload> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].CreateApp({ payload }))
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/** Admin `DeleteApp` (DELETE /apps/:id). Invalidates {@link APPS_LIST_QUERY_KEY}. */
const useAppsAdminDeleteMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].DeleteApp({ path: { id } }))
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/**
 * Admin `UpdatePlacement` (PATCH /apps/:id/placement). Unlike
 * {@link useAppsAdminUpdateMutation} (cloud-only content edits), placement
 * applies to **any** provenance — it's the homescreen's drag-to-reorder /
 * enable surface. Invalidates {@link APPS_LIST_QUERY_KEY} on success so the
 * reordered list refetches.
 */
const useAppsPlacementMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly payload: PlacementPayload }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].UpdatePlacement({ path: { id }, payload })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

export {
  APPS_LIST_QUERY_KEY,
  appsListQueryOptions,
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useAppsAdminUpdateMutation,
  useAppsListQuery,
  useAppsPlacementMutation,
}
export type { AppEntry, CreateAppPayload, PlacementPayload, UpdateAppPayload }
