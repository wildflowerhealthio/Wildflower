import AppsBridge from 'apps-core/bridge'
import { Effect, Layer } from 'effect'
import type { HostBinding } from 'effect-messaging-core'
import { useMemo, useRef } from 'react'
import type { TunnelStore } from 'tunnel-core/livestore'
import { ReceiverLayer, type AppsHostMessageSender } from './host-receiver-layer.ts'

interface UseAppsHostBindingOptions {
  /**
   * Discharges the `TunnelStore` Tag the receiver layer needs. Hosts
   * construct this via `TunnelStore.layerFrom(store)` and memoize it.
   */
  readonly tunnelStoreLayer: Layer.Layer<TunnelStore>
}

/**
 * Host binding for the apps bridge.
 *
 * Owns the host→web sender ref the receiver layer uses to reply to
 * `RequestTunnel` (`onTransportReady` writes; the layer reads through
 * the ref so a single hook keeps both halves in lockstep). Pre-discharges
 * `TunnelStore`.
 */
const useAppsHostBinding = ({
  tunnelStoreLayer,
}: UseAppsHostBindingOptions): HostBinding.HostBinding<typeof AppsBridge> => {
  const senderRef = useRef<AppsHostMessageSender | null>(null)

  return useMemo(
    () => ({
      bridge: AppsBridge,
      receiverLayer: ReceiverLayer(senderRef).pipe(Layer.provide(tunnelStoreLayer)),
      onTransportReady: (send) =>
        Effect.sync(() => {
          senderRef.current = send
        }),
    }),
    [tunnelStoreLayer]
  )
}

export { useAppsHostBinding }
export type { UseAppsHostBindingOptions }
