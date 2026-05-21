import { ReceiverLayer } from './host-receiver-layer.ts'
import { useNavigationHostBinding } from './use-host-binding.ts'

const NavigationBridgeExpo = {
  ReceiverLayer,
  useHostBinding: useNavigationHostBinding,
}

export { NavigationBridgeExpo }
export type { UseNavigationHostBindingOptions } from './use-host-binding.ts'
