import { LaunchError, type ListedServer } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'

import { failureText } from './failure-text.ts'
import { useOpenServerAuthorizationApp } from './queries.ts'
import { useRunHostCommand } from './router-context.ts'
import { useOnline } from './use-online.ts'

/** Opening a server's Wildflower Authorization app. */
interface AuthorizationAppOpening {
  /**
   * Whether the host would refuse to open it now: the webview is offline,
   * or the server's status is one the host refuses (see
   * `LaunchError.statusRefusalOf`).
   */
  readonly unavailable: boolean
  /** Whether an open is in flight. */
  readonly isOpening: boolean
  /** Why the latest open failed: the host's refusal, or the browser's failure. */
  readonly failure: Option.Option<string>
  /** Opens it, calling `onError` with the failure's text if it fails. */
  readonly open: (onError?: (failure: string) => void) => void
}

/**
 * Opening `server`'s Wildflower Authorization app through
 * `server_open_authorization_app`, in the in-app browser signed in as the
 * server's Owner.
 *
 * @remarks
 * The host opens it once the server is launchable, as it does a launch, so
 * it is unavailable while the webview is offline and whenever the host would
 * refuse for what the server's status shows. It never starts a server.
 */
const useAuthorizationAppOpening = (server: ListedServer.Type): AuthorizationAppOpening => {
  const online = useOnline()
  const openAuthorizationApp = useOpenServerAuthorizationApp(useRunHostCommand())
  return {
    unavailable: !online || Option.isSome(LaunchError.statusRefusalOf(server.status)),
    isOpening: openAuthorizationApp.isPending,
    failure: Option.fromNullable(openAuthorizationApp.error).pipe(Option.map(failureText)),
    open: (onError) => {
      openAuthorizationApp.mutate(
        { domain: server.domain },
        {
          onError: (error) => {
            onError?.(failureText(error))
          },
        }
      )
    },
  }
}

export { useAuthorizationAppOpening, type AuthorizationAppOpening }
