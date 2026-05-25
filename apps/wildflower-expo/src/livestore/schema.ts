import * as AppsLivestore from 'apps-core/livestore'
import * as CollectorLivestore from 'collector-core/livestore'
import * as EmrLivestore from 'emr-core/livestore'
import * as GatekeeperLivestore from 'gatekeeper-core/livestore'
import * as LocalHttpServerLivestore from 'local-http-server-core/livestore'
import { composeLivestoreModules } from 'shared-structures-core/livestore'
import * as TunnelLivestore from 'tunnel-core/livestore'

// Both `wildflower-node` and `wildflower-expo` route their schema
// composition through `composeLivestoreModules` with the slice list in
// the SAME order — drift in slice-order between hosts breaks
// cross-host LiveStore syncs, and the shared helper makes that single
// canonical order the only one a reviewer has to keep in their head.
const { events, schema, tables } = composeLivestoreModules([
  EmrLivestore,
  GatekeeperLivestore,
  CollectorLivestore,
  AppsLivestore,
  TunnelLivestore,
  LocalHttpServerLivestore,
] as const)

export { events, schema, tables }
