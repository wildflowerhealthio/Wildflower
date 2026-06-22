import { Effect } from 'effect'
import type { BridgeHandlerRecord } from 'effect-messaging-react'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import type { ActiveDeviceUserCodeStore } from 'gatekeeper-react'
import { makeGatekeeperWebHandlers } from 'gatekeeper-react/web-bridge'
import { NavigationBridge } from 'navigation-core'
import { makeNavigationWebHandlers, type NavTarget } from 'navigation-react'
import type { AuthTokenStore } from 'react-kitchen-sink'

import { applyColorScheme } from '../styles/apply-color-scheme.ts'
import { applyRootInsets } from '../styles/apply-root-insets.ts'

/**
 * The boot-stable inbound handler records, keyed by bridge name. Lives
 * next to `bridges.ts` so the bridge tuple, its derived type, and the
 * boot-stable handler seed all live as one cohesive seam — adding a
 * fifth boot-stable slice means editing one place, not two.
 *
 * Collector registers its real inbound handlers on mount through
 * `makeHandlerCoordinator`; until then the coordinator serves a
 * drop-all record for that bridge. Logging is web→host only on the
 * page side (no inbound handlers).
 *
 * `setToken` is the gatekeeper bridge's only piece of state — the
 * entry's `AuthTokenStore` constructs it (`makeWebAuthTokenStore`
 * persists to localStorage; `makeEmbeddedAuthTokenStore` is
 * in-memory) and the page-bridge handler writes through it on every
 * `AuthTokenIssued`.
 *
 * The navigation bridge's `SafeAreaInsetsChanged` and
 * `HostColorSchemeChanged` are wired to `applyRootInsets` and
 * `applyColorScheme` — stateless DOM writers, not per-entry state — so
 * they're imported here rather than threaded through `renderApp`. Standalone
 * web entries use a stub transport and never reach this seam, so they keep
 * zero padding (a browser has no notch to clear); their colour scheme comes
 * from `addOsColorSchemeListener`, which writes the same attribute from
 * `prefers-color-scheme` at boot.
 */
// No host emits `AuthTokenIssued` on the standalone-web or embedded
// entries (the standalone path serves a stub transport, and the
// embedded path is web-only). The handler is registered for
// type-completeness; the no-op puller would only fire if a future host
// started emitting on this transport.
const noTokenAvailable = (): Effect.Effect<string | null> => Effect.succeed(null)

const makeBootStableInitialHandlers = (
  navigate: (to: NavTarget) => void,
  setToken: AuthTokenStore['setToken'],
  setActiveDeviceUserCode: ActiveDeviceUserCodeStore['setActiveUserCode']
): Readonly<Record<string, BridgeHandlerRecord>> => ({
  [NavigationBridge.name]: makeNavigationWebHandlers({
    navigate,
    applyInsets: applyRootInsets,
    applyColorScheme,
  }),
  [GatekeeperBridge.name]: makeGatekeeperWebHandlers(
    setToken,
    setActiveDeviceUserCode,
    noTokenAvailable
  ),
})

export { makeBootStableInitialHandlers }
