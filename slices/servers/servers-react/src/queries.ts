import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
} from '@tanstack/react-query'
import { Effect, Either } from 'effect'
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
  type RunPolicy,
  type RunPolicyChoice,
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

/**
 * Cancel a read of the server list still in flight, then write `update` into
 * the cached list, then read the list again if a read was cancelled. When
 * nothing is cached, or `update` answers `undefined` because the list can't
 * take the change, the list is read again instead.
 *
 * @remarks
 * A read in flight could answer with what the host held before the change
 * `update` writes, and replace it.
 */
const updateCachedServers = async (
  queryClient: QueryClient,
  update: (servers: readonly ListedServer.Type[]) => readonly ListedServer.Type[] | undefined
): Promise<void> => {
  const readWasInFlight = queryClient.isFetching({ queryKey: SERVERS_QUERY_KEY }) > 0
  await queryClient.cancelQueries({ queryKey: SERVERS_QUERY_KEY })
  const servers = queryClient.getQueryData<readonly ListedServer.Type[]>(SERVERS_QUERY_KEY)
  const updated = servers === undefined ? undefined : update(servers)
  if (updated === undefined) {
    await queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
    return
  }
  queryClient.setQueryData<readonly ListedServer.Type[]>(SERVERS_QUERY_KEY, updated)
  if (readWasInFlight) {
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

/**
 * Sets when a server runs, and puts the policy the host stored into the
 * cached server list.
 */
const useSetServerRunPolicy = (
  runHostCommand: RunHostCommand
): UseMutationResult<
  RunPolicy.Type,
  HostCommandError,
  { readonly domain: string; readonly choice: RunPolicyChoice.Type }
> => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change) => runHostCommand(setServerRunPolicy(change)),
    onSuccess: (runPolicy, { domain }) =>
      updateCachedServers(queryClient, (servers) =>
        servers.map((server) => (server.domain === domain ? { ...server, runPolicy } : server))
      ),
  })
}

/** Removes a server, then reads the server list again, whether or not it was removed. */
const useRemoveServer = (
  runHostCommand: RunHostCommand
): UseMutationResult<null, HostCommandError, { readonly domain: string }> => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (server) => runHostCommand(removeServer(server)),
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
