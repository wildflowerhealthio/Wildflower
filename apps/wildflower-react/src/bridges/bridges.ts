import { AppsBridge } from 'apps-core/bridge'
import { CollectorBridge } from 'collector-fundamentals/bridge'
import { Logging } from 'effect-messaging-core'
import { GatekeeperBridge } from 'gatekeeper-core/bridge'
import { NavigationBridge } from 'navigation-core'

/**
 * The tuple of slice bridges wired into the page-side `BridgeTransport`.
 * Single source of truth: `build-transport.ts` reads the runtime value
 * and `transport-context.ts` derives the `Bridges` type from
 * `typeof bridges`, so the runtime list and the type can't drift.
 *
 * Order is irrelevant to dispatch (the transport routes by `_tag`). The
 * position-keyed `handlers` tuple consumed by
 * `BridgeTransport.makeWebTransport` is now reconstituted internally by
 * `makeHandlerCoordinator`'s `recompose`, so adjusting this list no
 * longer requires keeping a parallel list in `build-transport.ts` in
 * sync by hand.
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
