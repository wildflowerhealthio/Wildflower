import { CollectorBridge } from '@wildflowerhealthio/collector-fundamentals/bridge'
import { Logging } from '@wildflowerhealthio/effect-messaging-core'
import { GatekeeperBridge } from '@wildflowerhealthio/gatekeeper-core/bridge'
import { HarRecorderBridge } from '@wildflowerhealthio/har-recorder-core-js'
import { NavigationBridge } from '@wildflowerhealthio/navigation-core'
import { BackgroundServerServiceBridge } from '@wildflowerhealthio/wildflower-server-core-js'

/**
 * The tuple of slice bridges wired into the page-side transport.
 * Single source of truth: the Tauri entry passes the runtime value to
 * `makeTauriTransport` and `transport-context.ts` derives the `Bridges`
 * type from `typeof bridges`, so the runtime list and the type can't
 * drift. Order is irrelevant to dispatch (the transport routes by `_tag`).
 */
const bridges = [
  NavigationBridge,
  GatekeeperBridge,
  CollectorBridge,
  HarRecorderBridge,
  BackgroundServerServiceBridge,
  Logging.LogBridge,
] as const

type Bridges = typeof bridges

export { bridges }
export type { Bridges }
