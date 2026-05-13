/**
 * LiveStore bindings for apps domain.
 *
 * Exports flat, spread-safe `tables` / `events` / `materializers` records
 * that an app-level schema can merge into its own composition, following
 * the pattern of `collector-core/livestore`.
 */

import { makeSchema, State } from '@livestore/livestore'
import * as AppSelection from './app-selection.ts'

const tables = {
  appSelection: AppSelection.table,
} as const

const events = {
  ...AppSelection.events,
} as const

const queries = {
  appSelection$: AppSelection.queries.all$,
  appSelectionById$: AppSelection.queries.byId$,
} as const

const materializers = { ...AppSelection.materializers } as const

const state = State.SQLite.makeState({ tables, materializers })
const schema = makeSchema({ events, state })

export { AppSelection, tables, events, queries, materializers, schema, state }
export type { AppSelectionRow } from './app-selection.ts'
