import { makeNavigationHostHandlers } from './host-receiver-layer.ts'
import { useNavigationHostBinding } from './use-host-binding.ts'

/**
 * Navigation slice Expo host surface. `useHostBinding` aggregates the
 * handler record with the initial-route URL-param message;
 * `makeHostHandlers` is exported for direct composition.
 */
const NavigationBridgeExpo: {
  readonly makeHostHandlers: typeof makeNavigationHostHandlers
  readonly useHostBinding: typeof useNavigationHostBinding
} = {
  makeHostHandlers: makeNavigationHostHandlers,
  useHostBinding: useNavigationHostBinding,
}

export { NavigationBridgeExpo }
export type { UseNavigationHostBindingOptions } from './use-host-binding.ts'
