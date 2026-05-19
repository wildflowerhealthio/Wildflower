/**
 * LiveStore bindings for the local-http-server slice.
 *
 * Exports flat, spread-safe `tables` / `events` / `queries` /
 * `materializers` records that an app-level schema can merge into its
 * own composition. The slice's `LocalHttpServerStore` Effect tag carries
 * its `layerFrom(store)` factory as a static — the `schema` export
 * remains a type anchor for cross-package `Store<typeof schema>` tags.
 */

import { defineSliceLivestore, type InputMaterializers } from 'shared-structures-core/livestore'

import * as ServerState from './server-state.ts'

const tables: {
  readonly localHttpServerState: ServerState.Table
} = {
  localHttpServerState: ServerState.table,
} as const

const events: ServerState.Events = {
  ...ServerState.events,
} as const

const queries: ServerState.Queries = {
  ...ServerState.queries,
} as const

const materializers: InputMaterializers & ServerState.Materializers = {
  ...ServerState.materializers,
} as const

const { schema, state, StoreTag, makeLayerFactory } = defineSliceLivestore({
  name: 'LocalHttpServerStore',
  tables,
  events,
  materializers,
})

/**
 * Effect tag carrying the local-http-server slice's livestore Store.
 *
 * Wire it via `LocalHttpServerStore.layerFrom(store)` from the app-level
 * host package; consumers (e.g. {@link runHttpServerDaemon}) request this
 * tag rather than the bare livestore Store so app schemas can spread the
 * slice's tables/events/materializers without leaking the underlying
 * livestore type.
 */
class LocalHttpServerStore extends StoreTag<LocalHttpServerStore>() {
  static readonly layerFrom = makeLayerFactory(LocalHttpServerStore)
}

export { DEFAULT_IDLE_PORT, DEFAULT_LOCAL_ORIGIN } from './server-state.ts'
export { events, LocalHttpServerStore, materializers, queries, schema, ServerState, state, tables }
