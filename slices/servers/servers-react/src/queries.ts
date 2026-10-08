import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { DateTime, Effect, Either, Option, Schema } from 'effect'
import { useEffect } from 'react'
import {
  type HostCommandError,
  ListedServer,
  listServers,
  type NotificationPermission,
  readAppVersion,
  readNotificationPermission,
  removeServer,
  requestNotificationPermission,
  RunPolicy,
  RunPolicyChoice,
  ServerStatus,
  setServerRunPolicy,
} from 'servers-core'

import type { ListenToHostEvent, RunHostCommand } from './router-context.ts'

const NOTIFICATION_PERMISSION_QUERY_KEY = ['servers', 'notification-permission'] as const

const APP_VERSION_QUERY_KEY = ['servers', 'app-version'] as const

const SERVERS_QUERY_KEY = ['servers', 'list'] as const

/**
 * The servers on this device, each with its status on the host's unit
 * runner; {@link useServerStatusEvents} keeps the statuses current.
 */
const serversQueryOptions = (
  runHostCommand: RunHostCommand
): UseQueryOptions<
  readonly ListedServer.Type[],
  HostCommandError,
  readonly ListedServer.Type[],
  typeof SERVERS_QUERY_KEY
> =>
  queryOptions({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => runHostCommand(listServers),
  })

/** A change to the cached server list, or `undefined` when the list can't take it. */
type ServersUpdate = (
  servers: readonly ListedServer.Type[]
) => readonly ListedServer.Type[] | undefined

/**
 * Cancel a read of the server list still in flight, then write `update` into
 * the cached list.
 *
 * @returns Whether the list must be read again: a read was cancelled, or
 * nothing is cached, or `update` couldn't take the change.
 *
 * @remarks
 * A read in flight could answer with what the host held before the change
 * `update` writes, and replace it.
 */
const writeCachedServers = async (
  queryClient: QueryClient,
  update: ServersUpdate
): Promise<boolean> => {
  const readWasInFlight = queryClient.isFetching({ queryKey: SERVERS_QUERY_KEY }) > 0
  await queryClient.cancelQueries({ queryKey: SERVERS_QUERY_KEY })
  const servers = queryClient.getQueryData<readonly ListedServer.Type[]>(SERVERS_QUERY_KEY)
  const updated = servers === undefined ? undefined : update(servers)
  if (updated === undefined) return true
  queryClient.setQueryData<readonly ListedServer.Type[]>(SERVERS_QUERY_KEY, updated)
  return readWasInFlight
}

/**
 * {@link writeCachedServers}, then read the list again when it must be.
 */
const updateCachedServers = async (
  queryClient: QueryClient,
  update: ServersUpdate
): Promise<void> => {
  if (await writeCachedServers(queryClient, update)) {
    await queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
  }
}

/**
 * While mounted, put each `server-status` event's status into the cached
 * server list, in place of the listed server's own.
 *
 * @remarks
 * A status for a server the list doesn't hold, such as one just added,
 * reads the list again. A removed server gets no event; reading the list
 * again after its removal drops it. Once listening, the list is read again,
 * so a status that changed before the listener was up is not missed. A read
 * still in flight when a status arrives is read again (see
 * {@link updateCachedServers}).
 */
const useServerStatusEvents = (listenToHostEvent: ListenToHostEvent): void => {
  const queryClient = useQueryClient()
  useEffect(() => {
    const putStatus = (status: ServerStatus.Type): void => {
      void updateCachedServers(queryClient, (servers) =>
        servers.some((server) => server.domain === status.domain)
          ? servers.map((server) =>
              server.domain === status.domain ? ListedServer.withStatus(server, status) : server
            )
          : undefined
      )
    }
    let unmounted = false
    let stopListening: (() => void) | undefined
    void listenToHostEvent(ServerStatus.EVENT, ({ payload }) => {
      Either.match(ServerStatus.decodeEvent(payload), {
        onLeft: (error) => {
          Effect.runSync(
            Effect.logWarning(`[servers] a ${ServerStatus.EVENT} didn't decode`, error)
          )
        },
        onRight: putStatus,
      })
    }).then((stop) => {
      if (unmounted) {
        stop()
        return
      }
      stopListening = stop
      void queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
    })
    return () => {
      unmounted = true
      stopListening?.()
    }
  }, [listenToHostEvent, queryClient])
}

/** `servers` with the server `domain`'s run policy set to `runPolicy`. */
const withRunPolicy =
  (domain: string, runPolicy: RunPolicy.Type) =>
  (servers: readonly ListedServer.Type[]): readonly ListedServer.Type[] =>
    servers.map((server) => (server.domain === domain ? { ...server, runPolicy } : server))

/** Whether two run policies are the same policy, deadline and all. */
const sameRunPolicy = Schema.equivalence(RunPolicy.Schema)

/** What a run-policy change wrote to the cache before the host answered. */
interface OptimisticRunPolicy {
  /** The policy the choice becomes, written at once. */
  readonly optimistic: RunPolicy.Type
  /** The policy the cache held before, when it held the server. */
  readonly previous: Option.Option<RunPolicy.Type>
  /** Whether the list must be read again once the host answers. */
  readonly readAgain: boolean
}

/**
 * Sets when a server runs: writes the policy the choice becomes into the
 * cached server list at once, then the policy the host stored.
 *
 * @remarks
 * One mutation serves one server, and its picker is disabled while a change
 * is pending, so the previous policy is always one the host stored. The
 * optimistic write doesn't wait on a read of the list: a read it cancels is
 * made again once the host answers, so the command goes out at once.
 *
 * When the host refuses, the server's previous policy is put back, unless
 * the cache has since moved on from the one this change wrote, as when the
 * list was read again meanwhile. When there was no previous policy to put
 * back, the list is read again.
 */
const useSetServerRunPolicy = (
  runHostCommand: RunHostCommand
): UseMutationResult<
  RunPolicy.Type,
  HostCommandError,
  { readonly domain: string; readonly choice: RunPolicyChoice.Type },
  OptimisticRunPolicy
> => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change) => runHostCommand(setServerRunPolicy(change)),
    onMutate: async ({ domain, choice }) => {
      const previous = Option.fromNullable(
        queryClient
          .getQueryData<readonly ListedServer.Type[]>(SERVERS_QUERY_KEY)
          ?.find((server) => server.domain === domain)
      ).pipe(Option.map((server) => server.runPolicy))
      const optimistic = RunPolicyChoice.toRunPolicyAt(choice, DateTime.unsafeNow())
      const readAgain = await writeCachedServers(queryClient, withRunPolicy(domain, optimistic))
      return { optimistic, previous, readAgain }
    },
    onError: (_error, { domain }, written) => {
      if (written === undefined || Option.isNone(written.previous)) {
        return queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
      }
      const { optimistic } = written
      const runPolicy = written.previous.value
      return updateCachedServers(queryClient, (servers) =>
        servers.map((server) =>
          server.domain === domain && sameRunPolicy(server.runPolicy, optimistic)
            ? { ...server, runPolicy }
            : server
        )
      )
    },
    onSuccess: (runPolicy, { domain }) =>
      updateCachedServers(queryClient, withRunPolicy(domain, runPolicy)),
    onSettled: (_runPolicy, _error, _change, written) =>
      written?.readAgain === true
        ? queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
        : undefined,
  })
}

/**
 * Removes a server, then reads the server list again, whether or not it was
 * removed.
 *
 * @param onRemoved - Called once the host has removed the server, before the
 * list is read again.
 *
 * @remarks
 * `onRemoved` is the mutation's own callback, not one passed to `mutate`, so
 * it runs even when reading the list again unmounts the caller first.
 */
const useRemoveServer = (
  runHostCommand: RunHostCommand,
  onRemoved: () => void
): UseMutationResult<null, HostCommandError, { readonly domain: string }> => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (server) => runHostCommand(removeServer(server)),
    onSuccess: onRemoved,
    onSettled: () => queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY }),
  })
}

/** Whether the OS lets the app post notifications, read without asking. */
const notificationPermissionQueryOptions = (
  runHostCommand: RunHostCommand
): UseQueryOptions<
  NotificationPermission,
  HostCommandError,
  NotificationPermission,
  typeof NOTIFICATION_PERMISSION_QUERY_KEY
> =>
  queryOptions({
    queryKey: NOTIFICATION_PERMISSION_QUERY_KEY,
    queryFn: () => runHostCommand(readNotificationPermission),
  })

/** The app's version, which doesn't change while it runs. */
const appVersionQueryOptions = (
  runHostCommand: RunHostCommand
): UseQueryOptions<string, HostCommandError, string, typeof APP_VERSION_QUERY_KEY> =>
  queryOptions({
    queryKey: APP_VERSION_QUERY_KEY,
    queryFn: () => runHostCommand(readAppVersion),
    staleTime: Number.POSITIVE_INFINITY,
  })

/**
 * Asks the OS to let the app post notifications, and puts the permission it
 * answers with in the cache {@link notificationPermissionQueryOptions} reads.
 */
const useRequestNotificationPermission = (
  runHostCommand: RunHostCommand
): UseMutationResult<NotificationPermission, HostCommandError, void> => {
  const queryClient = useQueryClient()
  return useMutation<NotificationPermission, HostCommandError>({
    mutationFn: () => runHostCommand(requestNotificationPermission),
    onSuccess: (permission) => {
      queryClient.setQueryData(NOTIFICATION_PERMISSION_QUERY_KEY, permission)
    },
  })
}

export {
  appVersionQueryOptions,
  notificationPermissionQueryOptions,
  serversQueryOptions,
  useRemoveServer,
  useRequestNotificationPermission,
  useServerStatusEvents,
  useSetServerRunPolicy,
}
