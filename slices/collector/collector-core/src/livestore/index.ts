/**
 * LiveStore bindings for collector domain objects.
 *
 * Exports flat, spread-safe
 * `tables` / `events` / `queries` / `materializers` records that an
 * app-level schema can merge into its own composition, plus per-domain
 * namespaces for structured access.
 *
 * Consumers that want to treat `remotes` as an independent unit can use
 * the `Remote` namespace re-export. The `schema` export is primarily
 * useful as a type anchor for cross-package `Store<typeof schema>` tags.
 */

import { defineSliceLivestore } from 'shared-structures-core/livestore'

import * as RemoteConfig from './remote-config.ts'

// `RemoteConfig.Table` is the portable per-resource alias defined in
// `remote-config.ts`; referencing it here keeps the slice's emitted
// `.d.ts` self-contained — see `apps-core/src/livestore/index.ts` for
// the full rationale.
const tables: { readonly remotes: RemoteConfig.Table } = {
  remotes: RemoteConfig.table,
}

const events = {
  remoteAdded: RemoteConfig.events.remoteAdded,
  remoteUpdated: RemoteConfig.events.remoteUpdated,
  remoteDeleted: RemoteConfig.events.remoteDeleted,
} as const

const queries = {
  remotes$: RemoteConfig.queries.all$,
  remoteById$: RemoteConfig.queries.byId$,
  remotesByTag$: RemoteConfig.queries.byTag$,
} as const

const materializers = { ...RemoteConfig.materializers } as const

const { schema, state, StoreTag, makeLayerFactory } = defineSliceLivestore({
  name: 'CollectorStore',
  tables,
  events,
  materializers,
})

class CollectorStore extends StoreTag<CollectorStore>() {
  static readonly layerFrom = makeLayerFactory(CollectorStore)
}

export {
  CollectorStore,
  events,
  materializers,
  queries,
  RemoteConfig as Remote,
  schema,
  state,
  tables,
}
export type { RemoteRow } from './remote-config.ts'
