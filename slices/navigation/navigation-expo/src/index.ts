import { ReceiverLayer } from './host-receiver-layer.ts'
import { useNavigationHostBinding } from './use-host-binding.ts'

/**
 * Navigation slice Expo host surface. `useHostBinding` aggregates the
 * receiver layer with the initial-route URL-param message;
 * `ReceiverLayer` is exported for direct composition.
 */
const NavigationBridgeExpo: {
  readonly ReceiverLayer: typeof ReceiverLayer
  readonly useHostBinding: typeof useNavigationHostBinding
} = {
  ReceiverLayer,
  useHostBinding: useNavigationHostBinding,
}

export { NavigationBridgeExpo }
export type { UseNavigationHostBindingOptions } from './use-host-binding.ts'
