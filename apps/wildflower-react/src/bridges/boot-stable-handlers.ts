import type { BridgeHandlerRecord } from 'effect-messaging-react'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebHandlers, type NavTarget } from 'navigation-react'

/**
 * The boot-stable inbound handler records, keyed by bridge name. Lives
 * next to `bridges.ts` so the bridge tuple, its derived type, and the
 * boot-stable handler seed all live as one cohesive seam — adding a
 * fifth boot-stable slice means editing one place, not two.
 *
 * Collector and Apps register their real inbound handlers on mount
 * through `makeHandlerCoordinator`; until then the coordinator serves
 * a drop-all record for those bridges. Logging is web→host only on the
 * page side (no inbound handlers).
 */
const makeBootStableInitialHandlers = (
  navigate: (to: NavTarget) => void
): Readonly<Record<string, BridgeHandlerRecord>> => ({
  [NavigationBridge.name]: makeNavigationWebHandlers(navigate),
  [GatekeeperBridge.name]: makeGatekeeperWebHandlers(),
})

export { makeBootStableInitialHandlers }
