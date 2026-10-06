import {
  queryOptions,
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryOptions,
} from '@tanstack/react-query'
import {
  type HostCommandError,
  type ListedServer,
  listServers,
  type NotificationPermission,
  readAppVersion,
  readNotificationPermission,
  requestNotificationPermission,
} from 'servers-core'

import type { RunHostCommand } from './router-context.ts'

const NOTIFICATION_PERMISSION_QUERY_KEY = ['servers', 'notification-permission'] as const

const APP_VERSION_QUERY_KEY = ['servers', 'app-version'] as const

const SERVERS_QUERY_KEY = ['servers', 'list'] as const

/** The servers on this device, each with its current status. */
const serversQueryOptions = (
  runHostCommand: RunHostCommand
): UseQueryOptions<
  readonly ListedServer[],
  HostCommandError,
  readonly ListedServer[],
  typeof SERVERS_QUERY_KEY
> =>
  queryOptions({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => runHostCommand(listServers),
  })

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
  useRequestNotificationPermission,
}
