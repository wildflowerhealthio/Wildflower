import GatekeeperBridge from 'gatekeeper-core/bridge'
import {
  makeUseHostMessaging,
  type HostMessaging,
  type HostToWebMessage,
} from 'shared-structures-react'

/** Decoded union of every host→web message GatekeeperBridge accepts. */
type GatekeeperHostToWebMessage = HostToWebMessage<typeof GatekeeperBridge>

type GatekeeperHostMessaging = HostMessaging<typeof GatekeeperBridge>

/**
 * Read the host-side `GatekeeperBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `GatekeeperBridge` registered.
 */
const useGatekeeperHostMessaging = makeUseHostMessaging(GatekeeperBridge)

export { useGatekeeperHostMessaging }
export type { GatekeeperHostMessaging, GatekeeperHostToWebMessage }
