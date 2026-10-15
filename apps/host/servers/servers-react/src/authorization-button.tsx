import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { LaunchError, type ListedServer } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import type { JSX } from 'react'

import { failureText } from './failure-text.ts'
import { useOpenServerAuthorizationApp } from './queries.ts'
import type { RunHostCommand } from './router-context.ts'
import { useOnline } from './use-online.ts'

/**
 * A server's Authorization: opens its Wildflower Authorization app through
 * `server_open_authorization_app`, in the in-app browser signed in as the
 * server's Owner.
 *
 * @remarks
 * The host opens it once the server is launchable, as it does a launch, so it
 * is disabled while the webview is offline and whenever the host would refuse
 * for what the server's status shows (see `LaunchError.statusRefusalOf`),
 * described then by `statusDescriptionId`'s element; Launch beside it says
 * why when the status doesn't. It never starts a server. It reports each
 * open's start to `onActionStart` and the host's refusal to `onError`, for
 * its parent to show above the row of buttons it sits in.
 */
const AuthorizationButton = ({
  server,
  runHostCommand,
  className,
  statusDescriptionId,
  onActionStart,
  onError,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
  /** Sizes the button in its parent's layout. */
  readonly className?: string
  /**
   * The id of the element showing the server's status, which describes
   * Authorization while it is disabled.
   */
  readonly statusDescriptionId?: string
  /** Called as an open starts. */
  readonly onActionStart: () => void
  /** Called with the text of the host's refusal of an open. */
  readonly onError: (failure: string) => void
}): JSX.Element => {
  const online = useOnline()
  const openAuthorizationApp = useOpenServerAuthorizationApp(runHostCommand)
  const disabled = !online || Option.isSome(LaunchError.statusRefusalOf(server.status))
  return (
    <button
      type="button"
      className={cn('button-2 outline', className)}
      disabled={disabled || openAuthorizationApp.isPending}
      aria-describedby={disabled ? statusDescriptionId : undefined}
      onClick={() => {
        onActionStart()
        openAuthorizationApp.mutate(
          { domain: server.domain },
          {
            onError: (error) => {
              onError(failureText(error))
            },
          }
        )
      }}
    >
      Authorization
    </button>
  )
}

export { AuthorizationButton }
