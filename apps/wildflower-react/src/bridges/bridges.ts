import { AppsBridge } from 'apps-core/bridge'
import { CollectorBridge } from 'collector-fundamentals/bridge'
import { Logging } from 'effect-messaging-core'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { NavigationBridge } from 'navigation-core'

/**
 * The tuple of slice bridges wired into the page-side `BridgeTransport`.
 * Single source of truth: `build-transport.ts` reads the runtime value
 * and `transport-context.ts` derives the `Bridges` type from `typeof
 * bridges`, so the runtime list and the type can't drift.
 *
 * Order is irrelevant to dispatch (the transport routes by `_tag`), but
 * the position-keyed `layers` tuple in `BridgeTransport.make` is paired
 * by index — adjusting this list means adjusting the layer list in
 * `build-transport.ts` to match.
 */
const bridges = [
  NavigationBridge,
  GatekeeperBridge,
  CollectorBridge,
  AppsBridge,
  Logging.LogBridge,
] as const

type Bridges = typeof bridges

export { bridges }
export type { Bridges }
