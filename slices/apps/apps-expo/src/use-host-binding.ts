import { AppsBridge } from 'apps-core/bridge'
import { Effect } from 'effect'
import { HandlerHelpers, HostBindings } from 'effect-messaging-core'
import { useMemo, useRef } from 'react'
import type { TunnelStore } from 'tunnel-core/livestore'
import { type AppsHostSender, makeAppsHostHandlers } from './host-handlers.ts'

type TunnelLivestore = typeof TunnelStore.Service

interface UseAppsHostBindingOptions {
  /**
   * The livestore handle that owns the tunnel slice's tables. The hook
   * derives the `TunnelStore` layer internally via
   * `TunnelStore.layerFrom(store)`, so callers only need a stable
   * reference to the store (the wildflower-expo shell's
   * `useWildflowerStore()` returns one).
   */
  readonly store: TunnelLivestore
}

/**
 * Host binding for the apps bridge.
 *
 * Passes the supplied livestore handle and a reply sender to
 * {@link makeAppsHostHandlers}. The reply rides the host→web sender
 * captured here via `onTransportReady` into a binding-scoped ref — so the
 * `RequestTunnel` handler talks back through a closure over that ref, not
 * a module-level global. Before the transport is ready (sender still
 * `null`), a reply is log-and-dropped.
 */
const useAppsHostBinding = ({
  store,
}: UseAppsHostBindingOptions): HostBindings.HostBindings<readonly [typeof AppsBridge]> => {
  const senderRef = useRef<AppsHostSender | null>(null)
  return useMemo(
    () =>
      HostBindings.single({
        bridge: AppsBridge,
        handlers: makeAppsHostHandlers(store, (message) => {
          const send = senderRef.current
          return send === null
            ? HandlerHelpers.warnAboutDroppedTag('appsHostHandlers', message._tag)
            : send(message)
        }),
        onTransportReady: (send: AppsHostSender) =>
          Effect.sync(() => {
            senderRef.current = send
          }),
      }),
    [store]
  )
}

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
