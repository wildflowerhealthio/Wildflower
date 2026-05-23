import CollectorBridge from 'collector-fundamentals/bridge'
import {
  makeUseHostMessaging,
  type HostMessaging,
  type HostToWebMessage,
} from 'shared-structures-react'

/** Decoded union of every host→web message CollectorBridge accepts. */
type CollectorHostToWebMessage = HostToWebMessage<typeof CollectorBridge>

type CollectorHostMessaging = HostMessaging<typeof CollectorBridge>

/**
 * Read the host-side `CollectorBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `CollectorBridge` registered.
 */
const useCollectorHostMessaging = makeUseHostMessaging(CollectorBridge)

export { useCollectorHostMessaging }
export type { CollectorHostMessaging, CollectorHostToWebMessage }
