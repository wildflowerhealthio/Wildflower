import type { Subscribable } from 'effect'
import { createContext } from 'react'
import { makeSubscribableStore, useContextOrThrow, useSubscribable } from 'react-kitchen-sink'
import type { ServerServiceStatus } from 'wildflower-server-core-js'

/**
 * The page's only server-service state: the latest `ServerServiceStatus`
 * snapshot the host sent, or `null` before the first one arrives.
 *
 * @remarks
 * The host is the sole writer, through the boot-stable handler
 * `makeBackgroundServerServiceWebHandlers` builds. The page keeps no
 * state machine of its own and no persistence: the host re-sends the current
 * snapshot on every `__Ready`, so anything cached here could only be stale.
 */
interface ServerServiceStatusStore {
  /** The latest snapshot, or `null` before the first one arrives. */
  readonly subscribable: Subscribable.Subscribable<ServerServiceStatus | null>
  /** Replace the snapshot. Only the bridge handler calls this. */
  readonly setStatus: (status: ServerServiceStatus) => void
}

/**
 * Build an empty {@link ServerServiceStatusStore}. The app builds one per page
 * load; only the Tauri entry's transport writes to it.
 */
const makeServerServiceStatusStore = (): ServerServiceStatusStore => {
  const { subscribable, set } = makeSubscribableStore<ServerServiceStatus | null>(null)
  return { subscribable, setStatus: set }
}

/**
 * Holds the {@link ServerServiceStatusStore} for descendants of
 * `ServerServiceStatusProvider`. `null` outside one, where
 * {@link useServerServiceStatus} throws.
 */
const ServerServiceStatusContext = createContext<ServerServiceStatusStore | null>(null)
ServerServiceStatusContext.displayName = 'ServerServiceStatusContext'

/**
 * The latest server status snapshot, or `null` before the first one arrives.
 * Re-renders on every snapshot.
 *
 * @throws `NoContextException` outside a `<ServerServiceStatusProvider>`
 */
const useServerServiceStatus = (): ServerServiceStatus | null =>
  useSubscribable(useContextOrThrow(ServerServiceStatusContext).subscribable)

export { makeServerServiceStatusStore, ServerServiceStatusContext, useServerServiceStatus }
export type { ServerServiceStatusStore }
