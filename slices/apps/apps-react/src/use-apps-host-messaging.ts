import AppsBridge from 'apps-core/bridge'
import type { Effect } from 'effect'
import type { Message } from 'effect-messaging-core'
import { useHostMessagingContext } from 'effect-messaging-react'
import { useMemo } from 'react'

/** Decoded union of every host→web message AppsBridge accepts. */
type AppsHostToWebMessage = Message.Of<typeof AppsBridge.Host.OutboundSchemas>

/**
 * Host-side messaging surface narrowed to AppsBridge.
 *
 * - `send` — fire-and-forget. Runs the underlying Effect via `runFork`;
 *   buffering until the WebView is ready is handled by the transport.
 * - `sendEffect` — returns the Effect so callers can compose it inside
 *   other Effect programs.
 */
interface AppsHostMessaging {
  readonly send: (message: AppsHostToWebMessage) => void
  readonly sendEffect: (message: AppsHostToWebMessage) => Effect.Effect<void>
}

/**
 * Read the host-side `AppsBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `AppsBridge` registered.
 */
const useAppsHostMessaging = (): AppsHostMessaging => {
  const ctx = useHostMessagingContext()
  const messaging = useMemo<AppsHostMessaging>(
    () => ({ send: ctx.sendHost, sendEffect: ctx.sendHostEffect }),
    [ctx]
  )
  if (!ctx.bridges.includes(AppsBridge)) {
    throw new Error(
      'useAppsHostMessaging: AppsBridge is not registered in the surrounding <HostMessagingProvider>'
    )
  }
  return messaging
}

export { useAppsHostMessaging }
export type { AppsHostMessaging, AppsHostToWebMessage }
