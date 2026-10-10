import type { MessageHandler } from '@wildflowerhealthio/effect-messaging-core'
import type { BackgroundServerServiceBridge } from '@wildflowerhealthio/wildflower-server-core-js'
import { Effect } from 'effect'

import type { ServerServiceStatusStore } from './server-service-status-store.ts'

/**
 * Build the page's {@link BackgroundServerServiceBridge} inbound handler
 * record: each `ServerServiceStatus` replaces the snapshot in the store.
 *
 * @remarks
 * The Tauri entry passes this to its transport as a boot-stable (`initial`)
 * handler rather than registering it when a component mounts: the host answers
 * the page's `__Ready` with the current snapshot before any component has
 * mounted, and a bridge with no handler drops what it receives.
 */
const makeBackgroundServerServiceWebHandlers = (
  setStatus: ServerServiceStatusStore['setStatus']
): MessageHandler.HandlersFor<BackgroundServerServiceBridge['HostToWeb']> => ({
  ServerServiceStatus: (status) =>
    Effect.sync(() => {
      setStatus(status)
    }),
})

export { makeBackgroundServerServiceWebHandlers }
