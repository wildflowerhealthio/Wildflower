/**
 * LiveStore bindings for collector domain objects.
 *
 * Mirrors the shape of `emr-core/livestore`: exports flat, spread-safe
 * `tables` / `events` / `queries` / `materializers` records that an
 * app-level schema can merge into its own composition, plus per-domain
 * namespaces for structured access.
 *
 * Consumers that want to treat `remotes` as an independent unit can use
 * the `Remote` namespace re-export. The `schema` export is primarily
 * useful as a type anchor for cross-package `Store<typeof schema>` tags.
 */

import { makeSchema, State } from '@livestore/livestore'

import * as Remote from './remote.ts'

const tables = {
  remotes: Remote.table,
} as const

const events = {
  remoteAdded: Remote.events.remoteAdded,
  remoteUpdated: Remote.events.remoteUpdated,
  remoteDeleted: Remote.events.remoteDeleted,
} as const

const queries = {
  remotes$: Remote.queries.all$,
  remoteById$: Remote.queries.byId$,
} as const

const materializers = { ...Remote.materializers } as const

const state = State.SQLite.makeState({ tables, materializers })
const schema = makeSchema({ events, state })

export { Remote, tables, events, queries, materializers, schema, state }
export { RemoteIdSchema, RemoteConfig } from './remote.ts'
export type { RemoteId, RemoteConfigType, RemoteRow } from './remote.ts'
