import { AppsBridge } from 'apps-core/bridge'
import { Effect } from 'effect'
import { HostBindings } from 'effect-messaging-core'
import { useMemo } from 'react'
import type { TunnelStore } from 'tunnel-core/livestore'
import { type AppsHostSender, makeAppsHostHandlers, setAppsHostSender } from './host-handlers.ts'

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
 * Passes the supplied livestore handle straight to
 * {@link makeAppsHostHandlers} (the `TunnelStore` tag's resolved service
 * is that handle). The `RequestTunnel` handler replies through the
 * host→web sender captured here via `onTransportReady` — handlers no
 * longer reply through a same-bridge `send`, so the proactive sender is
 * threaded in once the transport is ready (and cleared on teardown).
 */
const useAppsHostBinding = ({
  store,
}: UseAppsHostBindingOptions): HostBindings.HostBindings<readonly [typeof AppsBridge]> =>
  useMemo(
    () =>
      HostBindings.single({
        bridge: AppsBridge,
        handlers: makeAppsHostHandlers(store),
        onTransportReady: (send: AppsHostSender) =>
          Effect.sync(() => {
            setAppsHostSender(send)
          }),
      }),
    [store]
  )

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
