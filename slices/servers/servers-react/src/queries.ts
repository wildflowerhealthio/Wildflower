import {
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
 * While mounted, put each `server-status` event's status into the cached
 * server list, in place of the listed server's own.
 *
 * @remarks
 * A status for a server the list doesn't hold, such as one just added,
 * reads the list again. A removed server gets no event; reading the list
 * again after its removal drops it. Once listening, the list is read again,
 * so a status that changed before the listener was up is not missed.
 */
const useServerStatusEvents = (listenToHostEvent: ListenToHostEvent): void => {
  const queryClient = useQueryClient()
  useEffect(() => {
    const putStatus = (status: ServerStatus.Type): void => {
      const servers = queryClient.getQueryData<readonly ListedServer.Type[]>(SERVERS_QUERY_KEY)
      if (servers?.some((server) => server.domain === status.domain) !== true) {
        void queryClient.invalidateQueries({ queryKey: SERVERS_QUERY_KEY })
        return
      }
      queryClient.setQueryData<readonly ListedServer.Type[]>(
        SERVERS_QUERY_KEY,
        servers.map((server) =>
          server.domain === status.domain ? ListedServer.withStatus(server, status) : server
        )
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
    onSuccess: (runPolicy, { domain }) => {
      queryClient.setQueryData<readonly ListedServer.Type[]>(SERVERS_QUERY_KEY, (servers) =>
        servers?.map((server) => (server.domain === domain ? { ...server, runPolicy } : server))
      )
    },
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
