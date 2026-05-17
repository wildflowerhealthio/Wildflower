/**
 * LiveStore bindings for the user's app selection.
 *
 * A single table keyed by app id covers both bundled and custom entries:
 * bundled rows only use `enabled`; custom rows carry `customName`,
 * `customUrl`, and `customRequiresTunnel`. Removing a custom entry deletes
 * the row; "removing" a bundled entry just toggles `enabled` to false.
 */

import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

const columns = {
  id: State.SQLite.text({ primaryKey: true }),
  kind: State.SQLite.text(), // 'bundled' | 'custom' | 'action'
  enabled: State.SQLite.boolean({ default: true }),
  customName: State.SQLite.text({ nullable: true }),
  customUrl: State.SQLite.text({ nullable: true }),
  customRequiresTunnel: State.SQLite.boolean({ nullable: true }),
}

type Table = State.SQLite.TableDef<
  State.SQLite.DefaultSqliteTableDef & { readonly name: 'AppSelection' },
  State.SQLite.TableOptions,
  Schema.Schema<
    Schema.Struct.Type<{ [K in keyof typeof columns]: (typeof columns)[K]['schema'] }>,
    Schema.Struct.Encoded<{ [K in keyof typeof columns]: (typeof columns)[K]['schema'] }>,
    never
  >
>

const table: Table = State.SQLite.table({
  name: 'AppSelection',
  columns,
})

type AppSelectionRow = (typeof table)['Type']

const appEnabledChanged = Events.synced({
  name: 'v1.AppEnabledChanged',
  schema: Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal('bundled', 'custom', 'action'),
    enabled: Schema.Boolean,
  }),
})

const customAppAdded = Events.synced({
  name: 'v1.CustomAppAdded',
  schema: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    url: Schema.String,
    requiresTunnel: Schema.Boolean,
  }),
})

const customAppUpdated = Events.synced({
  name: 'v1.CustomAppUpdated',
  schema: Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    requiresTunnel: Schema.optional(Schema.Boolean),
  }),
})

const customAppRemoved = Events.synced({
  name: 'v1.CustomAppRemoved',
  schema: Schema.Struct({ id: Schema.String }),
})

const events = {
  appEnabledChanged,
  customAppAdded,
  customAppUpdated,
  customAppRemoved,
} as const

type ConflictTarget = Parameters<ReturnType<typeof table.insert>['onConflict']>[0]
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const idConflictColumn = 'id' as unknown as ConflictTarget

const materializers = State.SQLite.materializers(events, {
  'v1.AppEnabledChanged': ({ id, kind, enabled }) =>
    table
      .insert({
        id,
        kind,
        enabled,
        customName: null,
        customUrl: null,
        customRequiresTunnel: null,
      })
      .onConflict(idConflictColumn, 'replace'),
  'v1.CustomAppAdded': ({ id, name, url, requiresTunnel }) =>
    table.insert({
      id,
      kind: 'custom',
      enabled: true,
      customName: name,
      customUrl: url,
      customRequiresTunnel: requiresTunnel,
    }),
  'v1.CustomAppUpdated': ({ id, name, url, requiresTunnel }) =>
    table
      .update({
        ...(name !== undefined && { customName: name }),
        ...(url !== undefined && { customUrl: url }),
        ...(requiresTunnel !== undefined && { customRequiresTunnel: requiresTunnel }),
      })
      .where({ id }),
  'v1.CustomAppRemoved': ({ id }) => table.delete().where({ id }),
})

const all$ = queryDb(table, { label: 'appSelection' })

// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const byId$ = (id: string) =>
  queryDb(table.where({ id }), {
    // Explicit `| undefined` so `awaitRow`'s
    // `LiveQueryDef<A | null | undefined>` constraint matches; without
    // it, `rows[0]` infers as `Row` (no narrowing for empty results).
    map: (rows): AppSelectionRow | undefined => rows[0],
    label: 'appSelectionById',
  })

const queries = { all$, byId$ } as const

export { table, events, materializers, queries }
export type { AppSelectionRow, Table }
