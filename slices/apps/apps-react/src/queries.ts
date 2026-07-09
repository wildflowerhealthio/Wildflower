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
 * Catalogue row as it arrives from `GET /apps` — a `provenance`-discriminated
 * union (see {@link Schemas.AppListEntrySchema}). The cloud variant carries its
 * stored launch `url` **template** and the self-hosted variant its `launchPath`
 * (both stored, origin-independent templates); the concrete launch target is
 * still resolved per request by POSTing to `/apps/:id`.
 */
type AppEntry = Schema.Schema.Type<typeof Schemas.AppListEntrySchema>
type AppContentBody = Schema.Schema.Type<typeof Schemas.AppContentBodySchema>
type HomeScreenPayload = Schema.Schema.Type<typeof Schemas.HomeScreenSchema>

/** Mutations invalidate this key on success so the next render refetches. */
const APPS_LIST_QUERY_KEY = ['apps', 'list'] as const

/**
 * Shared `mutationKey` for every `PUT /home-screen` writer. The home screen's
 * drag-reorder and the editor's enable toggle each call
 * {@link useReplaceHomeScreenMutation} from their own component, so they hold
 * *separate* mutation instances. Tagging both with this key lets either surface
 * observe an in-flight home-screen write across components via `useIsMutating`,
 * so a toggle can be blocked while a reorder is still landing (and vice versa).
 */
const HOME_SCREEN_MUTATION_KEY = ['apps', 'home-screen'] as const

/**
 * Shared `mutationKey` for every `PUT /apps/{id}` content writer. Each
 * self-hosted row's launch-path editor holds its **own**
 * {@link useAppsAdminReplaceMutation} instance, so the apps editor's
 * one-write-at-a-time fieldset lock can only see those writes across
 * components via `useIsMutating` on this key — without it, a Remove or toggle
 * could race a mid-flight launch-path save.
 */
const APP_CONTENT_MUTATION_KEY = ['apps', 'app-content'] as const

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

/**
 * Admin `ReplaceApp` (PUT /apps/:id). The `payload` is a provenance-discriminated
 * {@link AppContentBody} whose arm must match the target app's kind (cloud
 * content, or a self-hosted launch path). Invalidates {@link APPS_LIST_QUERY_KEY}.
 */
const useAppsAdminReplaceMutation = (): UseMutationResult<
  unknown,
  Error,
  { readonly id: string; readonly payload: AppContentBody }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: APP_CONTENT_MUTATION_KEY,
    mutationFn: ({ id, payload }) =>
      runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) =>
          // The generated request type is discriminated per payload arm, so
          // narrow on `provenance` before the call — a union-typed `payload`
          // isn't assignable to `{ payload: Cloud } | { payload: SelfHosted }`.
          c['apps-admin'].ReplaceApp(
            payload.provenance === 'cloud' ? { path: { id }, payload } : { path: { id }, payload }
          )
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/**
 * Admin `CreateApp` (POST /apps) — the **cloud** arm. `POST /apps` is now a
 * `multipart/form-data` route discriminated on `provenance`, so a multipart
 * endpoint's typed client payload is a `FormData`: this builds the cloud form
 * (`requiresTunnel` serialized as the text `"true"` / `"false"`) and posts it.
 * Invalidates {@link APPS_LIST_QUERY_KEY}.
 */
const useAppsAdminCreateMutation = (): UseMutationResult<
  unknown,
  Error,
  {
    readonly name: string
    readonly url: string
    readonly requiresTunnel: boolean
    readonly subtitle?: string
  }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ name, url, requiresTunnel, subtitle }) => {
      const form = new FormData()
      form.append('provenance', 'cloud')
      form.append('name', name)
      form.append('url', url)
      form.append('requiresTunnel', String(requiresTunnel))
      if (subtitle !== undefined) form.append('subtitle', subtitle)
      return runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].CreateApp({ payload: form }))
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: APPS_LIST_QUERY_KEY })
    },
  })
}

/**
 * Admin `CreateApp` (POST /apps) — the **self-hosted** arm. Posts the same
 * merged `multipart/form-data` route as the cloud arm (`provenance=self-hosted`)
 * with the zipped app bundle as the `bundle` file part; the server slugs `name`
 * into the new app's id/subdomain and extracts + installs the bundle. An
 * optional `subtitle` (omitted when empty) rides the same form.
 * Invalidates {@link APPS_LIST_QUERY_KEY} on success so the newly installed
 * self-hosted tile appears.
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
      form.append('provenance', 'self-hosted')
      form.append('name', name)
      if (subtitle !== undefined) form.append('subtitle', subtitle)
      form.append('bundle', bundle, 'bundle.zip')
      return runAuthed(
        Effect.flatMap(AppsAdminHttpApiClient, (c) => c['apps-admin'].CreateApp({ payload: form }))
      )
    },
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
 * `ReplaceHomeScreen` (PUT /home-screen). Unlike {@link useAppsAdminReplaceMutation}
 * (single-app content edits), this applies to **every** provenance — it's the
 * homescreen's single writer of order + `enabled`. The payload is the full
 * ordered list `[{ id, enabled }]` (array index = display position); the server
 * renumbers + flips atomically. Invalidates {@link APPS_LIST_QUERY_KEY} on
 * success so the reordered list refetches.
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
  appsListQueryOptions,
  useAppsAdminCreateMutation,
  useAppsAdminDeleteMutation,
  useAppsAdminReplaceMutation,
  useAppsListQuery,
  useReplaceHomeScreenMutation,
  useSelfHostedAppCreateMutation,
}
export type { AppContentBody, AppEntry, HomeScreenPayload }
