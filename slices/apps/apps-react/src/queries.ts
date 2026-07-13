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
 * Catalogue row as it arrives from `GET /apps` — the uniform
 * {@link Schemas.AppRegistrationSchema} (no `provenance` union to narrow).
 * Everything the homescreen tile renders is here; the per-kind payload (`url`,
 * `launchPath`) is an editor concern read on a per-kind detail lookup.
 */
type AppRegistration = Schema.Schema.Type<typeof Schemas.AppRegistrationSchema>
type CloudAppDetail = Schema.Schema.Type<typeof Schemas.CloudAppDetailSchema>
type SelfHostedAppDetail = Schema.Schema.Type<typeof Schemas.SelfHostedAppDetailSchema>
type SystemAppDetail = Schema.Schema.Type<typeof Schemas.SystemAppDetailSchema>
type CloudAppBody = Schema.Schema.Type<typeof Schemas.CloudAppBodySchema>
type HomeScreenPayload = Schema.Schema.Type<typeof Schemas.HomeScreenSchema>

/** Mutations invalidate this key on success so the next render refetches. */
const APPS_LIST_QUERY_KEY = ['apps', 'list'] as const

/** The per-kind detail query key for an app id (`GET /{kind}-apps/{id}`). */
const appDetailQueryKey = (kind: AppRegistration['kind'], id: string) =>
  ['apps', 'detail', kind, id] as const

/**
 * Shared `mutationKey` for every `PUT /home-screen` writer. The home screen's
 * drag-reorder and the editor's enable toggle each call
 * {@link useReplaceHomeScreenMutation} from their own component, so they hold
 * *separate* mutation instances. Tagging both with this key lets either surface
 * observe an in-flight home-screen write across components via `useIsMutating`.
 */
const HOME_SCREEN_MUTATION_KEY = ['apps', 'home-screen'] as const

/**
 * Shared `mutationKey` for every per-kind content writer. Each self-hosted row's
 * launch-path editor holds its **own** replace mutation instance, so the apps
 * editor's one-write-at-a-time fieldset lock can only see those writes across
 * components via `useIsMutating` on this key.
 */
const APP_CONTENT_MUTATION_KEY = ['apps', 'app-content'] as const

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

/** Detail read `GET /cloud-apps/{id}` — the cloud editor detail (404 if not cloud). */
const cloudAppQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<
  CloudAppDetail,
  Error,
  CloudAppDetail,
  ReturnType<typeof appDetailQueryKey>
> =>
  queryOptions({
    queryKey: appDetailQueryKey('cloud', id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].GetCloudApp({ path: { id } }))
      ),
  })

const useCloudAppQuery = (id: string): UseSuspenseQueryResult<CloudAppDetail, Error> =>
  useSuspenseQuery(cloudAppQueryOptions(useRunAuthed(), id))

/** Detail read `GET /self-hosted-apps/{id}` (404 if not self-hosted). */
const selfHostedAppQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<
  SelfHostedAppDetail,
  Error,
  SelfHostedAppDetail,
  ReturnType<typeof appDetailQueryKey>
> =>
  queryOptions({
    queryKey: appDetailQueryKey('self-hosted', id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].GetSelfHostedApp({ path: { id } })
        )
      ),
  })

const useSelfHostedAppQuery = (id: string): UseSuspenseQueryResult<SelfHostedAppDetail, Error> =>
  useSuspenseQuery(selfHostedAppQueryOptions(useRunAuthed(), id))

/** Detail read `GET /system-apps/{id}` (404 if not system). */
const systemAppQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<
  SystemAppDetail,
  Error,
  SystemAppDetail,
  ReturnType<typeof appDetailQueryKey>
> =>
  queryOptions({
    queryKey: appDetailQueryKey('system', id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].GetSystemApp({ path: { id } })
        )
      ),
  })

const useSystemAppQuery = (id: string): UseSuspenseQueryResult<SystemAppDetail, Error> =>
  useSuspenseQuery(systemAppQueryOptions(useRunAuthed(), id))

/**
 * Admin `CreateCloudApp` (POST /cloud-apps) — a JSON body. Invalidates
 * {@link APPS_LIST_QUERY_KEY} so the new tile appears.
 */
const useCloudAppCreateMutation = (): UseMutationResult<unknown, Error, CloudAppBody> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].CreateCloudApp({ payload }))
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/**
 * Admin `ReplaceCloudApp` (PUT /cloud-apps/:id) — a JSON content replace.
 * Invalidates the list and this app's cloud detail.
 */
const useCloudAppReplaceMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly payload: CloudAppBody }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: APP_CONTENT_MUTATION_KEY,
    mutationFn: ({ id, payload }) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].ReplaceCloudApp({ path: { id }, payload })
        )
      ),
    onSuccess: async (_result, { id }) => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: appDetailQueryKey('cloud', id) })
    },
  })
}

/**
 * Admin `CreateSelfHostedApp` (POST /self-hosted-apps) — a `multipart/form-data`
 * body (a `FormData`): the app `name`, an optional `subtitle`, and the zipped
 * `bundle` file part. Invalidates {@link APPS_LIST_QUERY_KEY}.
 */
const useSelfHostedAppCreateMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly name: string; readonly bundle: Blob; readonly subtitle?: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, bundle, subtitle }) => {
      const form = new FormData()
      form.append('name', name)
      if (subtitle !== undefined) form.append('subtitle', subtitle)
      form.append('bundle', bundle, 'bundle.zip')
      return runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].CreateSelfHostedApp({ payload: form })
        )
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/**
 * Admin `ReplaceSelfHostedApp` (PUT /self-hosted-apps/:id) — replaces the launch
 * path (empty clears it). Invalidates the list and this app's self-hosted detail.
 */
const useSelfHostedAppReplaceMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly launchPath: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: APP_CONTENT_MUTATION_KEY,
    mutationFn: ({ id, launchPath }) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          c['apps-admin'].ReplaceSelfHostedApp({ path: { id }, payload: { launchPath } })
        )
      ),
    onSuccess: async (_result, { id }) => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: appDetailQueryKey('self-hosted', id) })
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
 * `ReplaceHomeScreen` (PUT /home-screen). Unlike the per-kind content edits, this
 * applies to **every** kind — it's the homescreen's single writer of order +
 * `enabled`. The payload is the full ordered list `[{ id, enabled }]` (array index
 * = display position); the server renumbers + flips atomically. Invalidates
 * {@link APPS_LIST_QUERY_KEY} on success so the reordered list refetches.
 */
const useReplaceHomeScreenMutation = (): UseMutationResult<unknown, Error, HomeScreenPayload> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: HOME_SCREEN_MUTATION_KEY,
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
  APP_CONTENT_MUTATION_KEY,
  APPS_LIST_QUERY_KEY,
  HOME_SCREEN_MUTATION_KEY,
  appDetailQueryKey,
  appsListQueryOptions,
  cloudAppQueryOptions,
  selfHostedAppQueryOptions,
  systemAppQueryOptions,
  useAppsAdminDeleteMutation,
  useAppsListQuery,
  useCloudAppCreateMutation,
  useCloudAppQuery,
  useCloudAppReplaceMutation,
  useReplaceHomeScreenMutation,
  useSelfHostedAppCreateMutation,
  useSelfHostedAppQuery,
  useSelfHostedAppReplaceMutation,
  useSystemAppQuery,
}
export type {
  AppRegistration,
  CloudAppBody,
  CloudAppDetail,
  HomeScreenPayload,
  SelfHostedAppDetail,
  SystemAppDetail,
}
