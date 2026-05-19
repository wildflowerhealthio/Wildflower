import { Events, queryDb, Schema, State } from '@livestore/livestore'

/**
 * Persistent singleton row id. The TunnelConfig table only ever holds
 * one row — `TUNNEL_CONFIG_ID` keeps reads / writes addressing the same
 * row across restarts.
 */
const TUNNEL_CONFIG_ID = 'tunnel' as const

const columns = {
  id: State.SQLite.text({ primaryKey: true }),
  subdomain: State.SQLite.text({ nullable: true }),
  rootDomain: State.SQLite.text({ nullable: true }),
  localPort: State.SQLite.integer({ nullable: true }),
  requestedEnabled: State.SQLite.boolean({ default: false }),
} as const

type Table = State.SQLite.TableDef<
  State.SQLite.DefaultSqliteTableDef & { readonly name: 'TunnelConfig' },
  State.SQLite.TableOptions,
  Schema.Schema<
    Schema.Struct.Type<{ [K in keyof typeof columns]: (typeof columns)[K]['schema'] }>,
    Schema.Struct.Encoded<{ [K in keyof typeof columns]: (typeof columns)[K]['schema'] }>,
    never
  >
>

/**
 * User/host-owned tunnel config — persistent across sessions.
 *
 * `subdomain` / `rootDomain` / `localPort` define the tunnel target the
 * daemon should bring up. `requestedEnabled` is the on/off intent —
 * persisted so leaving the tunnel enabled auto-resumes after a restart.
 *
 * The daemon reads this table and writes only `TunnelState`; nothing
 * here is daemon-owned.
 */
const table: Table = State.SQLite.table({
  name: 'TunnelConfig',
  columns,
})

type TunnelConfigRow = (typeof table)['Type']

const tunnelConfigSet = Events.clientOnly({
  name: 'v1.TunnelConfigSet',
  schema: Schema.Struct({
    subdomain: Schema.optional(Schema.NullOr(Schema.String)),
    rootDomain: Schema.optional(Schema.NullOr(Schema.String)),
    localPort: Schema.optional(Schema.NullOr(Schema.Number)),
    requestedEnabled: Schema.optional(Schema.Boolean),
  }),
})

type EventsRecord = {
  tunnelConfigSet: typeof tunnelConfigSet
}

const events: EventsRecord = { tunnelConfigSet } as const

type ConflictTarget = Parameters<ReturnType<typeof table.insert>['onConflict']>[0]
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const idConflictColumn = 'id' as unknown as ConflictTarget

const materializers = State.SQLite.materializers(events, {
  // Patch semantics: omitted fields preserve prior values. On a fresh
  // install (no row yet) the omitted fields fall back to the column
  // defaults — `requestedEnabled: false`, everything else null.
  'v1.TunnelConfigSet': ({ subdomain, rootDomain, localPort, requestedEnabled }, { query }) => {
    const existing = query(table.where({ id: TUNNEL_CONFIG_ID }))[0]
    return table
      .insert({
        id: TUNNEL_CONFIG_ID,
        subdomain: subdomain !== undefined ? subdomain : (existing?.subdomain ?? null),
        rootDomain: rootDomain !== undefined ? rootDomain : (existing?.rootDomain ?? null),
        localPort: localPort !== undefined ? localPort : (existing?.localPort ?? null),
        requestedEnabled:
          requestedEnabled !== undefined ? requestedEnabled : (existing?.requestedEnabled ?? false),
      })
      .onConflict(idConflictColumn, 'replace')
  },
})

type Materializers = typeof materializers

const current$ = queryDb(table.where({ id: TUNNEL_CONFIG_ID }), {
  // The single-row contract is enforced by `TUNNEL_CONFIG_ID` on every
  // write. Map to `TunnelConfigRow | undefined` so the daemon (and HTTP
  // handler) can distinguish "fresh install, never seeded" from a
  // commit with all-null fields.
  map: (rows): TunnelConfigRow | undefined => rows[0],
  label: 'tunnelConfig',
})

type Queries = {
  current$: typeof current$
}

const queries: Queries = { current$ } as const

export { events, materializers, queries, table, TUNNEL_CONFIG_ID }
export type { EventsRecord as Events, Materializers, Queries, Table, TunnelConfigRow }
