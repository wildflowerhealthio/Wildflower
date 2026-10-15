import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { LaunchError, type ListedServer } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import type { JSX } from 'react'

import { failureText } from './failure-text.ts'
import { useOpenServerAuthorizationApp } from './queries.ts'
import type { RunHostCommand } from './router-context.ts'
import { useOnline } from './use-online.ts'
import styles from './authorization-button.module.css'

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
 * why when the status doesn't. It never starts a server. The host's refusal
 * shows above it, never below.
 */
const AuthorizationButton = ({
  server,
  runHostCommand,
  className,
  statusDescriptionId,
}: {
  readonly server: ListedServer.Type
  readonly runHostCommand: RunHostCommand
  /** Sizes the button's block in its parent's layout. */
  readonly className?: string
  /**
   * The id of the element showing the server's status, which describes
   * Authorization while it is disabled.
   */
  readonly statusDescriptionId?: string
}): JSX.Element => {
  const online = useOnline()
  const openAuthorizationApp = useOpenServerAuthorizationApp(runHostCommand)
  const disabled = !online || Option.isSome(LaunchError.statusRefusalOf(server.status))
  return (
    <div className={cn(styles['authorization-button'], className)}>
      <ErrorBanner
        error={openAuthorizationApp.error === null ? null : failureText(openAuthorizationApp.error)}
      />
      <button
        type="button"
        className="button-2 outline"
        disabled={disabled || openAuthorizationApp.isPending}
        aria-describedby={disabled ? statusDescriptionId : undefined}
        onClick={() => {
          openAuthorizationApp.mutate({ domain: server.domain })
        }}
      >
        Authorization
      </button>
    </div>
  )
}

export { AuthorizationButton }
