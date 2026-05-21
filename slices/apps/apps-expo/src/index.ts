import { ReceiverLayer } from './host-receiver-layer.ts'
import { useAppsHostBinding } from './use-host-binding.ts'

/**
 * Apps slice's Expo host surface. `ReceiverLayer` is the raw
 * `Layer<…, never, TunnelStore>` factory; `useHostBinding` is the
 * React hook wrapping it in a `SliceHostBinding` that has
 * `TunnelStore` already discharged. Shells should reach for
 * `useHostBinding`; the receiver layer is kept exported for direct
 * composition (slice-internal tests, etc.).
 */
const AppsBridgeExpo = {
  ReceiverLayer,
  useHostBinding: useAppsHostBinding,
}

export { AppsBridgeExpo }
export type { UseAppsHostBindingOptions } from './use-host-binding.ts'
