import { ReceiverLayer } from './host-receiver-layer.ts'
import { useAppsHostBinding } from './use-host-binding.ts'

/**
 * Apps slice Expo host surface. `useHostBinding` is the typical entry
 * point; `ReceiverLayer` is exported for direct composition (e.g. tests).
 */
const AppsBridgeExpo = {
  ReceiverLayer,
  useHostBinding: useAppsHostBinding,
}

export { AppsBridgeExpo }
export type { UseAppsHostBindingOptions } from './use-host-binding.ts'
