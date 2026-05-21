import AppsBridge from 'apps-core/bridge'
import CollectorBridge from 'collector-fundamentals/bridge'
import GatekeeperBridge from 'gatekeeper-core/bridge'
import { NavigationBridge } from 'navigation-core'

type Bridges = readonly [
  typeof NavigationBridge,
  typeof GatekeeperBridge,
  typeof CollectorBridge,
  typeof AppsBridge,
]

/**
 * The fixed tuple of bridges the wildflower-expo shell composes into
 * its messaging transport. Stable identity; consumers (the
 * `<HostMessagingProvider>` and the `<WithTransport>` config) read
 * the same const so the per-render dep arrays stay stable.
 */
const bridges: Bridges = [NavigationBridge, GatekeeperBridge, CollectorBridge, AppsBridge] as const

export { bridges }
export type { Bridges }
