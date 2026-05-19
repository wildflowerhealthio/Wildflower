/**
 * LiveStore bindings for apps domain.
 *
 * Exports flat, spread-safe `tables` / `events` / `materializers` records
 * that an app-level schema can merge into its own composition, following
 * the pattern of `collector-core/livestore`.
 */

import { defineSliceLivestore } from 'shared-structures-core/livestore'

import * as AppSelection from './app-selection.ts'

// `AppSelection.Table` is the portable per-resource alias defined in
// `app-selection.ts` (spelled as `State.SQLite.TableDef<…, …, Schema.Schema<…>>`
// using only top-level livestore + effect types). Referencing it here keeps
// the slice's emitted `.d.ts` self-contained without inferring `tables` from
// the runtime value's narrow type, which would pull in `FieldColumnType` /
// `ColumnDefaultValue` from livestore's internal `field-defs.js` subpath.
const tables: { readonly appSelection: AppSelection.Table } = {
  appSelection: AppSelection.table,
}

const events = {
  ...AppSelection.events,
} as const

const queries = {
  appSelection$: AppSelection.queries.all$,
  appSelectionById$: AppSelection.queries.byId$,
} as const

const materializers = { ...AppSelection.materializers } as const

const { schema, state, StoreTag, makeLayerFactory } = defineSliceLivestore({
  name: 'AppsStore',
  tables,
  events,
  materializers,
})

class AppsStore extends StoreTag<AppsStore>() {
  static readonly layerFrom = makeLayerFactory(AppsStore)
}

export { AppsStore, AppSelection, events, materializers, queries, schema, state, tables }
export type { AppSelectionRow } from './app-selection.ts'
