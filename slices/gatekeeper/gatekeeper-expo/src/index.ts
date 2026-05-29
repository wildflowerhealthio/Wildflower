import { useGatekeeperHostBinding } from './use-host-binding.ts'

export {
  useNotificationTapHandler,
  type NotificationTap,
} from './hooks/use-notification-tap-handler.ts'

const GatekeeperBridgeExpo: {
  readonly useHostBinding: typeof useGatekeeperHostBinding
} = {
  useHostBinding: useGatekeeperHostBinding,
}

export { GatekeeperBridgeExpo }
