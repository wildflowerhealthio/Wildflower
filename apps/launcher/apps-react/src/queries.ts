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
import { AppsAdminHttpApiClient, AppsHttpApiClient } from 'apps-core-js/clients'
import type { Schemas } from 'apps-core-js/http-api-definition'
import { Effect, type Schema } from 'effect'

import type { RouterContext, RunAuthed } from './router-context.ts'

// Annotated `select` so the result stays typed when the slice's router
// isn't registered (standalone build).
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

/**
 * An app as it arrives from `GET /apps` and `GET /apps/{id}` — the
 * {@link Schemas.AppRegistrationSchema}: everything the homescreen tile renders
 * and the editor edits.
 */
type AppRegistration = Schema.Schema.Type<typeof Schemas.AppRegistrationSchema>
type AppBody = Schema.Schema.Type<typeof Schemas.AppBodySchema>
type HomeScreenPayload = Schema.Schema.Type<typeof Schemas.HomeScreenSchema>

/** Mutations invalidate this key on success so the next render refetches. */
const APPS_LIST_QUERY_KEY = ['apps', 'list'] as const

/** The by-id query key for an app (`GET /apps/{id}`). */
const appQueryKey = (id: string) => ['apps', 'byId', id] as const

/** Shared by route `loader` (`ensureQueryData`) and {@link useAppsListQuery}. */
const appsListQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<
  readonly AppRegistration[],
  Error,
  readonly AppRegistration[],
  typeof APPS_LIST_QUERY_KEY
> =>
  queryOptions({
    queryKey: APPS_LIST_QUERY_KEY,
    queryFn: () => runAuthed(Effect.flatMap(AppsHttpApiClient, (c) => c.apps.ListApps())),
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useAppsListQuery = (): UseSuspenseQueryResult<readonly AppRegistration[], Error> =>
  useSuspenseQuery(appsListQueryOptions(useRunAuthed()))

/** By-id read `GET /apps/{id}` — the editor's app (404 if unknown). */
const appQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<
  AppRegistration,
  Error,
  AppRegistration,
  ReturnType<typeof appQueryKey>
> =>
  queryOptions({
    queryKey: appQueryKey(id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].GetApp({ path: { id } }))
      ),
  })

const useAppQuery = (id: string): UseSuspenseQueryResult<AppRegistration, Error> =>
  useSuspenseQuery(appQueryOptions(useRunAuthed(), id))

/**
 * Admin `CreateApp` (POST /apps) — a JSON body. Invalidates
 * {@link APPS_LIST_QUERY_KEY} so the new tile appears.
 */
const useAppCreateMutation = (): UseMutationResult<unknown, Error, AppBody> => {
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

/**
 * Admin `ReplaceApp` (PUT /apps/:id) — a JSON content replace. Invalidates the
 * list and this app's by-id read.
 */
const useAppReplaceMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly payload: AppBody }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].ReplaceApp({ path: { id }, payload })
        )
      ),
    onSuccess: async (_result, { id }) => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: appQueryKey(id) })
    },
  })
}

/** Admin `DeleteApp` (DELETE /apps/:id). Invalidates {@link APPS_LIST_QUERY_KEY}. */
const useAppDeleteMutation = (): UseMutationResult<unknown, Error, { readonly id: string }> => {
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
 * `ReplaceHomeScreen` (PUT /home-screen). Unlike the per-app content edits, this
 * applies to **every** app — it's the homescreen's single writer of order +
 * `onHomescreen`. The payload is the full ordered list `[{ id, onHomescreen }]`
 * (array index = display position); the server renumbers + flips atomically. Invalidates
 * {@link APPS_LIST_QUERY_KEY} on success so the reordered list refetches.
 */
const useReplaceHomeScreenMutation = (): UseMutationResult<unknown, Error, HomeScreenPayload> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].ReplaceHomeScreen({ payload })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

export {
  APPS_LIST_QUERY_KEY,
  appQueryKey,
  appQueryOptions,
  appsListQueryOptions,
  useAppCreateMutation,
  useAppDeleteMutation,
  useAppQuery,
  useAppReplaceMutation,
  useAppsListQuery,
  useReplaceHomeScreenMutation,
}
export type { AppBody, AppRegistration, HomeScreenPayload }
