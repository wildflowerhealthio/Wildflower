import { NavigationBridge } from 'navigation-core'
import {
  makeUseHostMessaging,
  type HostMessaging,
  type HostToWebMessage,
} from 'shared-structures-react'

/** Decoded union of every host→web message NavigationBridge accepts. */
type NavigationHostToWebMessage = HostToWebMessage<typeof NavigationBridge>

type NavigationHostMessaging = HostMessaging<typeof NavigationBridge>

/**
 * Read the host-side `NavigationBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `NavigationBridge` registered.
 */
const useNavigationHostMessaging = makeUseHostMessaging(NavigationBridge)

export { useNavigationHostMessaging }
export type { NavigationHostMessaging, NavigationHostToWebMessage }
