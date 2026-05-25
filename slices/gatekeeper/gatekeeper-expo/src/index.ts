import { useGatekeeperHostBinding } from './use-host-binding.ts'

export {
  useNotificationTapHandler,
  type NotificationTap,
} from './hooks/use-notification-tap-handler.ts'

const GatekeeperBridgeExpo = {
  useHostBinding: useGatekeeperHostBinding,
}

export { GatekeeperBridgeExpo }
