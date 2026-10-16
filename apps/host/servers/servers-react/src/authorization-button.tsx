import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { ListedServer } from '@wildflowerhealthio/servers-core-js'
import type { JSX } from 'react'

import { useAuthorizationAppOpening } from './authorization-app-opening.ts'

/**
 * A server's card's Authorization: opens its Wildflower Authorization app
 * (see `useAuthorizationAppOpening`).
 *
 * @remarks
 * While unavailable it is disabled, described then by
 * `statusDescriptionId`'s element; the card says why above it when the
 * status doesn't. It reports each open's start to `onActionStart` and the host's
 * refusal to `onError`, for its parent to show above the row of buttons it
 * sits in.
 */
const AuthorizationButton = ({
  server,
  className,
  statusDescriptionId,
  onActionStart,
  onError,
}: {
  readonly server: ListedServer.Type
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
  const { unavailable, isOpening, open } = useAuthorizationAppOpening(server)
  return (
    <button
      type="button"
      className={cn('button-2 outline', className)}
      disabled={unavailable || isOpening}
      aria-describedby={unavailable ? statusDescriptionId : undefined}
      onClick={() => {
        onActionStart()
        open(onError)
      }}
    >
      Authorization
    </button>
  )
}

export { AuthorizationButton }
