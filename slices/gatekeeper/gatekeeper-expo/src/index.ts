import { ReceiverLayer } from './host-receiver-layer.ts'
import { useGatekeeperHostBinding } from './use-host-binding.ts'

export {
  useNotificationTapHandler,
  type NotificationTap,
} from './hooks/use-notification-tap-handler.ts'

/**
 * Gatekeeper slice Expo host surface. `useHostBinding` carries the
 * auth-token dispatch policy; `ReceiverLayer` is the empty host-handler
 * factory exported for direct composition.
 */
const GatekeeperBridgeExpo = {
  ReceiverLayer,
  useHostBinding: useGatekeeperHostBinding,
}

export { GatekeeperBridgeExpo }
export type { UseGatekeeperHostBindingOptions } from './use-host-binding.ts'
