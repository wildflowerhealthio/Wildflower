import { AppsBridge } from 'apps-core/bridge'
import { HostBindings } from 'effect-messaging-core'
import { useMemo } from 'react'
import type { TunnelStore } from 'tunnel-core/livestore'
import { makeAppsHostHandlers } from './host-receiver-layer.ts'

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
 * is that handle); the `RequestTunnel` handler replies via
 * `AppsBridge.Host.send(...)` (whose `TransportAdapter` requirement the
 * bridge transport's dispatch fiber discharges per invocation).
 */
const useAppsHostBinding = ({
  store,
}: UseAppsHostBindingOptions): HostBindings.HostBindings<readonly [typeof AppsBridge]> =>
  useMemo(
    () =>
      HostBindings.single({
        bridge: AppsBridge,
        handlers: makeAppsHostHandlers(store),
      }),
    [store]
  )

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
