import CollectorBridge from 'collector-fundamentals/bridge'
import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import { useHostMessagingContext } from 'effect-messaging-react'
import { useMemo } from 'react'

/** Decoded union of every host→web message CollectorBridge accepts. */
type CollectorHostToWebMessage = Message.Of<typeof CollectorBridge.Host.OutboundSchemas>

/**
 * Host-side messaging surface narrowed to CollectorBridge.
 *
 * - `send` — fire-and-forget. Runs the underlying Effect via `runFork`;
 *   buffering until the WebView is ready is handled by the transport.
 * - `sendEffect` — returns the Effect so callers can compose it inside
 *   other Effect programs (typed sniffer-event forwarders in
 *   `<CollectorModalScreen>` use this to re-emit each tag inside the
 *   `BrowserSnifferBridge.Host` handler that decoded it).
 */
interface CollectorHostMessaging {
  readonly send: (message: CollectorHostToWebMessage) => void
  readonly sendEffect: (message: CollectorHostToWebMessage) => Effect.Effect<void>
}

/**
 * Read the host-side `CollectorBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `CollectorBridge` registered.
 */
const useCollectorHostMessaging = (): CollectorHostMessaging => {
  const ctx = useHostMessagingContext()
  const messaging = useMemo<CollectorHostMessaging>(
    () => ({ send: ctx.sendHost, sendEffect: ctx.sendHostEffect }),
    [ctx]
  )
  if (!ctx.bridges.includes(CollectorBridge)) {
    throw new Error(
      'useCollectorHostMessaging: CollectorBridge is not registered in the surrounding <HostMessagingProvider>'
    )
  }
  return messaging
}

export { useCollectorHostMessaging }
export type { CollectorHostMessaging, CollectorHostToWebMessage }
