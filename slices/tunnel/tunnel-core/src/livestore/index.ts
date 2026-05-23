/**
 * LiveStore bindings for the tunnel slice.
 *
 * Two tables:
 *
 *  - `TunnelConfig` — persistent singleton holding user/host intent
 *    (`subdomain`, `rootDomain`, `requestedRunning`). Carries across
 *    restarts; the daemon reads it but never writes to it. The
 *    forward-target port is sourced from `LocalHttpServerState.port`
 *    (joined in via `daemon/resolved-config.ts`), not duplicated here.
 *  - `TunnelState` — per-session, daemon-owned. Tracks what the daemon
 *    actually achieved (`running`, `currentSubdomain`, `currentRootDomain`,
 *    `currentLocalPort`) and surfaces `error`. Resets each session.
 *
 * Also exports `servedOrigin$`: a computed query joining `TunnelState`
 * and `LocalHttpServerState` into "where is the server reachable right
 * now" — `https://sub.root` when the tunnel is up, else
 * `http://localHostname:port`.
 *
 * Exports flat, spread-safe `tables` / `events` / `queries` /
 * `materializers` records that an app-level schema can merge into its
 * own composition.
 */

import { defineSliceLivestore, type InputMaterializers } from 'shared-structures-core/livestore'

import { servedOrigin$ } from './served-origin.ts'
import * as TunnelConfig from './tunnel-config.ts'
import * as TunnelState from './tunnel-state.ts'

const tables: {
  readonly tunnelState: TunnelState.Table
  readonly tunnelConfig: TunnelConfig.Table
} = {
  tunnelState: TunnelState.table,
  tunnelConfig: TunnelConfig.table,
} as const

type Events = TunnelState.Events & TunnelConfig.Events

const events: Events = {
  ...TunnelState.events,
  ...TunnelConfig.events,
} as const

type Queries = {
  readonly tunnelState: TunnelState.Queries
  readonly tunnelConfig: TunnelConfig.Queries
}

const queries: Queries = {
  tunnelState: TunnelState.queries,
  tunnelConfig: TunnelConfig.queries,
} as const

const materializers: InputMaterializers & TunnelState.Materializers & TunnelConfig.Materializers = {
  ...TunnelState.materializers,
  ...TunnelConfig.materializers,
} as const

const { schema, state, StoreTag, makeLayerFactory } = defineSliceLivestore({
  name: 'TunnelStore',
  tables,
  events,
  materializers,
})

/**
 * Effect tag carrying the tunnel slice's livestore Store. Wire it via
 * `TunnelStore.layerFrom(store)` from the app-level host package;
 * consumers (e.g. `apps-core` HTTP handlers and tunnel-react components)
 * request this tag rather than the bare livestore Store so app schemas
 * can spread the slice's tables/events/materializers without leaking
 * the underlying livestore type.
 */
class TunnelStore extends StoreTag<TunnelStore>() {
  static readonly layerFrom = makeLayerFactory(TunnelStore)
}

export {
  events,
  materializers,
  queries,
  schema,
  servedOrigin$,
  state,
  tables,
  TunnelConfig,
  TunnelState,
  TunnelStore,
}
