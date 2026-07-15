import {
  queryOptions,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
  type UseMutationResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from '@tanstack/react-query'
import { CollectorHttpApiClient } from 'collector-registry/clients'
import type { Remotes } from 'collector-registry/http-api-definition'
import { Effect, type Schema } from 'effect'

import type { RunAuthed } from '../router-context.ts'
import { REMOTES_QUERY_KEY, remoteQueryKey } from './keys.ts'
import { useRunAuthed } from './use-run-authed.ts'

type Remote = Schema.Schema.Type<typeof Remotes.RemoteSchema>
type CreateRemotePayload = Schema.Schema.Type<typeof Remotes.CreateRemotePayloadSchema>
type UpdateRemotePayload = Schema.Schema.Type<typeof Remotes.UpdateRemotePayloadSchema>

/** Shared by the route `loader` (`ensureQueryData`) and {@link useRemotesQuery}. */
const remotesQueryOptions = (
  runAuthed: RunAuthed
): UseSuspenseQueryOptions<readonly Remote[], Error, readonly Remote[], typeof REMOTES_QUERY_KEY> =>
  queryOptions({
    queryKey: REMOTES_QUERY_KEY,
    queryFn: () =>
      runAuthed(
        Effect.flatMap(CollectorHttpApiClient, (c) => c['collector-remotes'].ListRemotes())
      ),
  })

/** Reads synchronously from cache when the route loader has already warmed it. */
const useRemotesQuery = (): UseSuspenseQueryResult<readonly Remote[], Error> =>
  useSuspenseQuery(remotesQueryOptions(useRunAuthed()))

/** Shared by the route `loader` and {@link useRemoteQuery}. */
const remoteQueryOptions = (
  runAuthed: RunAuthed,
  id: string
): UseSuspenseQueryOptions<Remote, Error, Remote, readonly [string, string, string]> =>
  queryOptions({
    queryKey: remoteQueryKey(id),
    queryFn: () =>
      runAuthed(
        Effect.flatMap(CollectorHttpApiClient, (c) =>
          c['collector-remotes'].GetRemote({ path: { id } })
        )
      ),
  })

const useRemoteQuery = (id: string): UseSuspenseQueryResult<Remote, Error> =>
  useSuspenseQuery(remoteQueryOptions(useRunAuthed(), id))

/** `CreateRemote` (POST). Invalidates the accounts list. */
const useCreateRemoteMutation = (): UseMutationResult<Remote, Error, CreateRemotePayload> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload) =>
      runAuthed(
        Effect.flatMap(CollectorHttpApiClient, (c) =>
          c['collector-remotes'].CreateRemote({ payload })
        )
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: REMOTES_QUERY_KEY })
    },
  })
}

/** `UpdateRemote` (PUT). Invalidates the accounts list + the edited remote's detail. */
const useUpdateRemoteMutation = (): UseMutationResult<
  Remote,
  Error,
  { readonly id: string; readonly payload: UpdateRemotePayload }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }) =>
      runAuthed(
        Effect.flatMap(CollectorHttpApiClient, (c) =>
          c['collector-remotes'].UpdateRemote({ path: { id }, payload })
        )
      ),
    onSuccess: async (_data, { id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: REMOTES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: remoteQueryKey(id) }),
      ])
    },
  })
}

/** `DeleteRemote` (DELETE). Invalidates the accounts list + the deleted remote's detail. */
const useDeleteRemoteMutation = (): UseMutationResult<
  { readonly deleted: boolean },
  Error,
  { readonly id: string }
> => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }) =>
      runAuthed(
        Effect.flatMap(CollectorHttpApiClient, (c) =>
          c['collector-remotes'].DeleteRemote({ path: { id } })
        )
      ),
    onSuccess: async (_data, { id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: REMOTES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: remoteQueryKey(id) }),
      ])
    },
  })
}

export {
  remoteQueryOptions,
  remotesQueryOptions,
  useCreateRemoteMutation,
  useDeleteRemoteMutation,
  useRemoteQuery,
  useRemotesQuery,
  useUpdateRemoteMutation,
}
export type { CreateRemotePayload, Remote, UpdateRemotePayload }
