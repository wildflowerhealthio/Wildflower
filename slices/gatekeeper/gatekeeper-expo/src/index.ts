import { ReceiverLayer } from './host-receiver-layer.ts'
import { useGatekeeperHostBinding } from './use-host-binding.ts'

export {
  useNotificationTapHandler,
  type NotificationTap,
} from './hooks/use-notification-tap-handler.ts'

/**
 * Gatekeeper slice's Expo host surface. {@link ReceiverLayer} is the
 * empty host-handler layer (gatekeeper has no inbound messages today);
 * {@link useHostBinding} wraps it with the auth-token dispatch policy.
 * Shells should reach for {@link useHostBinding}; the receiver layer
 * is kept exported for direct composition (e.g. legacy callers).
 */
const GatekeeperBridgeExpo = {
  ReceiverLayer,
  useHostBinding: useGatekeeperHostBinding,
}

export { GatekeeperBridgeExpo }
export type { UseGatekeeperHostBindingOptions } from './use-host-binding.ts'
