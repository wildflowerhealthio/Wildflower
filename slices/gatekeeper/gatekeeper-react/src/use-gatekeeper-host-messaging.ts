import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import { useHostMessagingContext } from 'effect-messaging-react'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { useMemo } from 'react'

/** Decoded union of every host→web message GatekeeperBridge accepts. */
type GatekeeperHostToWebMessage = Message.Of<typeof GatekeeperBridge.Host.OutboundSchemas>

/**
 * Host-side messaging surface narrowed to GatekeeperBridge.
 *
 * - `send` — fire-and-forget. Runs the underlying Effect via `runFork`;
 *   buffering until the WebView is ready is handled by the transport.
 * - `sendEffect` — returns the Effect so callers can compose it inside
 *   other Effect programs.
 */
interface GatekeeperHostMessaging {
  readonly send: (message: GatekeeperHostToWebMessage) => void
  readonly sendEffect: (message: GatekeeperHostToWebMessage) => Effect.Effect<void>
}

/**
 * Read the host-side `GatekeeperBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `GatekeeperBridge` registered.
 */
const useGatekeeperHostMessaging = (): GatekeeperHostMessaging => {
  const ctx = useHostMessagingContext()
  const messaging = useMemo<GatekeeperHostMessaging>(
    () => ({ send: ctx.sendHost, sendEffect: ctx.sendHostEffect }),
    [ctx]
  )
  if (!ctx.bridges.includes(GatekeeperBridge)) {
    throw new Error(
      'useGatekeeperHostMessaging: GatekeeperBridge is not registered in the surrounding <HostMessagingProvider>'
    )
  }
  return messaging
}

export { useGatekeeperHostMessaging }
export type { GatekeeperHostMessaging, GatekeeperHostToWebMessage }
