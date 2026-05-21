import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import { useHostMessagingContext } from 'effect-messaging-react'
import { NavigationBridge } from 'navigation-core'
import { useMemo } from 'react'

/** Decoded union of every host→web message NavigationBridge accepts. */
type NavigationHostToWebMessage = Message.Of<typeof NavigationBridge.Host.OutboundSchemas>

/**
 * Host-side messaging surface narrowed to NavigationBridge.
 *
 * - `send` — fire-and-forget. Runs the underlying Effect via `runFork`;
 *   buffering until the WebView is ready is handled by the transport.
 * - `sendEffect` — returns the Effect so callers can compose it inside
 *   other Effect programs (e.g. a `BrowserSnifferBridge.Host` handler).
 */
interface NavigationHostMessaging {
  readonly send: (message: NavigationHostToWebMessage) => void
  readonly sendEffect: (message: NavigationHostToWebMessage) => Effect.Effect<void>
}

/**
 * Read the host-side `NavigationBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `NavigationBridge` registered.
 *
 * @remarks
 * The wide context senders (`(msg: { _tag: string }) => …`) are
 * structurally assignable to the narrowed signatures here via
 * function-parameter contravariance — no `as` cast needed at this layer.
 */
const useNavigationHostMessaging = (): NavigationHostMessaging => {
  const ctx = useHostMessagingContext()
  const messaging = useMemo<NavigationHostMessaging>(
    () => ({ send: ctx.sendHost, sendEffect: ctx.sendHostEffect }),
    [ctx]
  )
  if (!ctx.bridges.includes(NavigationBridge)) {
    throw new Error(
      'useNavigationHostMessaging: NavigationBridge is not registered in the surrounding <HostMessagingProvider>'
    )
  }
  return messaging
}

export { useNavigationHostMessaging }
export type { NavigationHostMessaging, NavigationHostToWebMessage }
