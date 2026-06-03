import type { BridgeHandlerRecord } from 'effect-messaging-react'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebHandlers, type NavTarget } from 'navigation-react'
import type { AuthTokenStore } from 'react-kitchen-sink'

import { applyRootInsets } from '../styles/apply-root-insets.ts'

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
 *
 * `setToken` is the gatekeeper bridge's only piece of state — the
 * entry's `AuthTokenStore` constructs it (`makeWebAuthTokenStore`
 * persists to localStorage; `makeEmbeddedAuthTokenStore` is
 * in-memory) and the page-bridge handler writes through it on every
 * `AuthTokenIssued`.
 *
 * The navigation bridge's `SafeAreaInsetsChanged` is wired to
 * `applyRootInsets` — a stateless DOM writer, not per-entry state — so
 * it's imported here rather than threaded through `renderApp`. Standalone
 * web entries use a stub transport and never reach this seam, so they
 * keep zero padding (a browser has no notch to clear).
 */
const makeBootStableInitialHandlers = (
  navigate: (to: NavTarget) => void,
  setToken: AuthTokenStore['setToken']
): Readonly<Record<string, BridgeHandlerRecord>> => ({
  [NavigationBridge.name]: makeNavigationWebHandlers(navigate, applyRootInsets),
  [GatekeeperBridge.name]: makeGatekeeperWebHandlers(setToken),
})

export { makeBootStableInitialHandlers }
