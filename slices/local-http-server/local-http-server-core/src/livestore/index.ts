/**
 * LiveStore bindings for the local-http-server slice.
 *
 * Exports flat, spread-safe `tables` / `events` / `queries` /
 * `materializers` records that an app-level schema can merge into its
 * own composition. The `schema` export is primarily a type anchor for
 * cross-package `Store<typeof schema>` tags.
 */

import { makeSchema, State } from '@livestore/livestore'
import * as ServerState from './server-state.ts'

const tables = {
  localHttpServerState: ServerState.table,
} as const

const events = {
  ...ServerState.events,
} as const

const queries = {
  ...ServerState.queries,
} as const

const materializers = State.SQLite.materializers(events, {
  ...ServerState.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })
const schema = makeSchema({ events, state })

export { events, materializers, queries, schema, ServerState, state, tables }
