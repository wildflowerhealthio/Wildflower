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

import * as RemoteConfig from './remote-config.ts'

const tables = {
  remotes: RemoteConfig.table,
} as const

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

const state = State.SQLite.makeState({ tables, materializers })
const schema = makeSchema({ events, state })

export { events, materializers, queries, RemoteConfig as Remote, schema, state, tables }
export type { RemoteRow } from './remote-config.ts'
