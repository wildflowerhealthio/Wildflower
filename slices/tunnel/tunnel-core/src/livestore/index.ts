/**
 * LiveStore bindings for the tunnel slice.
 *
 * Exports flat, spread-safe `tables` / `events` / `queries` /
 * `materializers` records that an app-level schema can merge into its
 * own composition. The slice's `TunnelStore` Effect tag carries its
 * `layerFrom(store)` factory as a static — the `schema` export remains
 * a type anchor for cross-package `Store<typeof schema>` tags.
 */

import { defineSliceLivestore, type InputMaterializers } from 'kitchen-sink/livestore'

import * as TunnelState from './tunnel-state.ts'

const tables: {
  readonly tunnelState: TunnelState.Table
} = {
  tunnelState: TunnelState.table,
} as const

const events: TunnelState.Events = {
  ...TunnelState.events,
} as const

const queries: TunnelState.Queries = {
  ...TunnelState.queries,
} as const

const materializers: InputMaterializers & TunnelState.Materializers = {
  ...TunnelState.materializers,
} as const

const { schema, state, StoreTag, makeLayerFactory } = defineSliceLivestore({
  name: 'TunnelStore',
  tables,
  events,
  materializers,
})

/**
 * Effect tag carrying the tunnel slice's livestore Store.
 *
 * Wire it via `TunnelStore.layerFrom(store)` from the app-level host
 * package; consumers (e.g. `apps-core` HTTP handlers and tunnel-react
 * components) request this tag rather than the bare livestore Store so
 * app schemas can spread the slice's tables/events/materializers
 * without leaking the underlying livestore type.
 */
class TunnelStore extends StoreTag<TunnelStore>() {
  static readonly layerFrom = makeLayerFactory(TunnelStore)
}

export { events, materializers, queries, schema, state, tables, TunnelState, TunnelStore }
