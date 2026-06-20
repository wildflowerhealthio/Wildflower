import { HttpClient, HttpClientRequest } from '@effect/platform'
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
import { DatabasesHttpApiClient } from 'databases-core/clients'
import type { Databases } from 'databases-core/http-api-definition'
import { Effect, type Schema } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'

import { buildDatabasesClientLayer } from './client/databases-client.ts'
import type { RouterContext, RunAuthed } from './router-context.ts'

// Annotated `select` so the result stays typed when the slice's router isn't
// registered (standalone build).
const useRunAuthed = (): RunAuthed =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runAuthed })

type DatabaseMetadata = Schema.Schema.Type<typeof Databases.DatabaseMetadataSchema>

/** External mutators of the databases list (export/delete) should invalidate this. */
const DATABASES_QUERY_KEY = ['databases', 'list'] as const

/** Shared by the route `loader` (`ensureQueryData`) and {@link useDatabasesQuery}. */
const databasesQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<
  readonly DatabaseMetadata[],
  Error,
  readonly DatabaseMetadata[],
  typeof DATABASES_QUERY_KEY
> =>
  queryOptions({
    queryKey: DATABASES_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(DatabasesHttpApiClient, (client) => client.databases.ListDatabases()).pipe(
          Effect.provide(buildDatabasesClientLayer())
        )
      ),
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useDatabasesQuery = (): UseSuspenseQueryResult<readonly DatabaseMetadata[], Error> =>
  useSuspenseQuery(databasesQueryOptions(useRunAuthed()))

/** `DeleteDatabase` (DELETE). Invalidates the databases list so sizes/existence refresh. */
const useDeleteDatabaseMutation = (): UseMutationResult<
  { readonly deleted: boolean },
  Error,
  { readonly id: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) =>
      runAuthed(
        Effect.flatMap(DatabasesHttpApiClient, (client) =>
          client.databases.DeleteDatabase({ path: { id } })
        ).pipe(Effect.provide(buildDatabasesClientLayer()))
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: DATABASES_QUERY_KEY })
    },
  })
}

/** The bytes + filename of an exported database, ready to hand to the browser. */
interface DatabaseExport {
  // `Uint8Array<ArrayBuffer>` (not the default `ArrayBufferLike`) so the bytes
  // are a valid `BlobPart` for the browser-side `new Blob([...])` save.
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly filename: string
}

/**
 * Fetch a database export as raw bytes. The export endpoint
 * (`GET /databases/:id`) streams a binary SQLite snapshot, so it isn't part of
 * the JSON `DatabasesApi`; this hits it through the platform `HttpClient`
 * directly, attaching the bearer from {@link BearerToken} the same way the
 * generated client does. The caller hands the bytes to the browser (see the
 * settings screen's `saveBytesAsFile`).
 */
const exportDatabaseEffect = (
  id: string
): Effect.Effect<DatabaseExport, Error, HttpClient.HttpClient | BearerToken> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const tokenSubscribable = yield* BearerToken
    const token = yield* tokenSubscribable.get
    const baseRequest = HttpClientRequest.get(`/databases/${encodeURIComponent(id)}`)
    const request =
      token === null
        ? baseRequest
        : HttpClientRequest.setHeader(baseRequest, 'Authorization', `Bearer ${token}`)
    const response = yield* client.execute(request)
    const buffer = yield* response.arrayBuffer
    return { bytes: new Uint8Array(buffer), filename: id }
  })

/** `useMutation` wrapper around {@link exportDatabaseEffect}; the component saves the bytes onSuccess. */
const useExportDatabaseMutation = (): UseMutationResult<
  DatabaseExport,
  Error,
  { readonly id: string }
> => {
  const runAuthed = useRunAuthed()
  return useMutation({
    mutationFn: ({ id }) => runAuthed(exportDatabaseEffect(id)),
  })
}

export {
  DATABASES_QUERY_KEY,
  databasesQueryOptions,
  exportDatabaseEffect,
  useDatabasesQuery,
  useDeleteDatabaseMutation,
  useExportDatabaseMutation,
  useRunAuthed,
}
export type { DatabaseExport, DatabaseMetadata, RunAuthed }
