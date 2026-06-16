import { AppsBridge } from 'apps-core/bridge'
import { Effect } from 'effect'
import { HandlerHelpers, HostBindings } from 'effect-messaging-core'
import { useMemo, useRef } from 'react'
import { type AppsHostSender, makeAppsHostHandlers } from './host-handlers.ts'

/**
 * Host binding for the apps bridge.
 *
 * Wires {@link makeAppsHostHandlers} to a reply sender. The reply rides the
 * host→web sender captured here via `onPageReady` into a binding-scoped ref —
 * so the `RequestTunnel` handler talks back through a closure over that ref,
 * not a module-level global. Before the page has posted `__Ready` (sender
 * still `null`), a reply is log-and-dropped. `onPageReady` re-fires on every
 * WebView reload; the repeat ref write is benign (same sender identity for
 * the transport's lifetime).
 *
 * @remarks
 * Reference scaffolding: the `RequestTunnel` flow is a no-op today (its tunnel
 * seams were stubbed when the TS server stack was removed) and this binding
 * has no live consumer. It previously took the page's livestore handle to
 * drive the tunnel daemon; that injection point disappears with the no-op
 * seams and will be reintroduced (as a Rust-tunnel client) when rewired.
 */
const useAppsHostBinding = (): HostBindings.HostBindings<readonly [typeof AppsBridge]> => {
  const senderRef = useRef<AppsHostSender | null>(null)
  return useMemo(
    () =>
      HostBindings.single({
        bridge: AppsBridge,
        handlers: makeAppsHostHandlers((message) => {
          const send = senderRef.current
          return send === null
            ? HandlerHelpers.warnAboutDroppedTag('appsHostHandlers', message._tag)
            : send(message)
        }),
        onPageReady: (send: AppsHostSender) =>
          Effect.sync(() => {
            senderRef.current = send
          }),
      }),
    []
  )
}

export { useAppsHostBinding }
