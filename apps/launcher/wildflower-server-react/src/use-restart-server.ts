import { Effect } from 'effect'
import { useCallback } from 'react'

import { useBackgroundServerServiceSender } from './use-background-server-service-sender.ts'

/**
 * Ask the host to restart the server: stop it if it is running, then start it.
 *
 * @returns A click handler that sends `RestartServer`. Nothing comes back to
 *   it: the host's next status snapshots (`starting`, then `running` or
 *   `stopped`) say how the restart went.
 */
const useRestartServer = (): (() => void) => {
  const send = useBackgroundServerServiceSender()
  return useCallback(() => {
    Effect.runFork(send({ _tag: 'RestartServer' }))
  }, [send])
}

export { useRestartServer }
