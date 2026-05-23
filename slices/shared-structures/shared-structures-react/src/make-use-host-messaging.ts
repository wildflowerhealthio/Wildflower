import type { Effect } from 'effect'
import type { Bridge, Message } from 'effect-messaging-core'
import { useHostMessagingContext } from 'effect-messaging-react'
import { useMemo } from 'react'

/** Decoded union of every host→web message a given bridge accepts. */
type HostToWebMessage<B extends Bridge.AnyBridge> = Message.Of<B['Host']['OutboundSchemas']>

/**
 * Host-side messaging surface narrowed to a single bridge.
 *
 * - `send` — fire-and-forget. Runs the underlying Effect via `runFork`;
 *   buffering until the WebView is ready is handled by the transport.
 * - `sendEffect` — returns the Effect so callers can compose it inside
 *   other Effect programs (typed re-emit forwarders use this to chain
 *   the send into a parent handler's `Effect.gen`).
 */
interface HostMessaging<B extends Bridge.AnyBridge> {
  readonly send: (message: HostToWebMessage<B>) => void
  readonly sendEffect: (message: HostToWebMessage<B>) => Effect.Effect<void>
}

/**
 * Build a `use<Slice>HostMessaging` hook for a slice's bridge. The
 * returned hook reads the surrounding `<HostMessagingProvider>` via
 * {@link useHostMessagingContext}, fails fast if the provider was
 * mounted without this bridge, and exposes a `{ send, sendEffect }`
 * narrowed to the bridge's `HostToWeb` messages via function-parameter
 * contravariance on the underlying `sendHost` / `sendHostEffect`.
 *
 * @example
 * ```ts
 * import { NavigationBridge } from 'navigation-core'
 * import { makeUseHostMessaging } from 'shared-structures-react'
 *
 * const useNavigationHostMessaging = makeUseHostMessaging(NavigationBridge)
 * export { useNavigationHostMessaging }
 * ```
 */
const makeUseHostMessaging = <B extends Bridge.AnyBridge>(bridge: B): (() => HostMessaging<B>) => {
  const hookName = `use${bridge.name}HostMessaging`
  const useHostMessaging = (): HostMessaging<B> => {
    const ctx = useHostMessagingContext()
    const messaging = useMemo<HostMessaging<B>>(
      () => ({
        // `ctx.sendHost` / `ctx.sendHostEffect` are typed wide
        // (`(msg: { _tag: string }) => …`) so the React context can
        // hold one shape. The narrower per-bridge return signature is
        // sound at runtime (the transport dispatches by `_tag`), but
        // TS can't carry the contravariance through the generic `B`
        // constraint to `HostToWebMessage<B>`. Same cast pattern as
        // `host-messaging-context.tsx`'s provider widening.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        send: ctx.sendHost as HostMessaging<B>['send'],
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        sendEffect: ctx.sendHostEffect as HostMessaging<B>['sendEffect'],
      }),
      [ctx]
    )
    if (!ctx.bridges.includes(bridge)) {
      throw new Error(
        `${hookName}: ${bridge.name}Bridge is not registered in the surrounding <HostMessagingProvider>`
      )
    }
    return messaging
  }
  return useHostMessaging
}

export { makeUseHostMessaging }
export type { HostMessaging, HostToWebMessage }
