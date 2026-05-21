import AppsBridge from 'apps-core/bridge'
import {
  makeUseHostMessaging,
  type HostMessaging,
  type HostToWebMessage,
} from 'shared-structures-react'

/** Decoded union of every host→web message AppsBridge accepts. */
type AppsHostToWebMessage = HostToWebMessage<typeof AppsBridge>

type AppsHostMessaging = HostMessaging<typeof AppsBridge>

/**
 * Read the host-side `AppsBridge` messaging surface from the
 * surrounding `<HostMessagingProvider>`. Throws fast at first call if
 * the provider was mounted without `AppsBridge` registered.
 */
const useAppsHostMessaging = makeUseHostMessaging(AppsBridge)

export { useAppsHostMessaging }
export type { AppsHostMessaging, AppsHostToWebMessage }
