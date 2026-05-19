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
  requestedRunning: State.SQLite.boolean({ default: false }),
} as const

/**
 * User/host-owned tunnel config — persistent across sessions.
 *
 * `subdomain` / `rootDomain` / `localPort` define the tunnel target the
 * daemon should bring up. `requestedRunning` is the on/off intent —
 * persisted so leaving the tunnel enabled auto-resumes after a restart.
 * Mirrors `LocalHttpServerState.requestedRunning` so the two daemons
 * share vocabulary.
 *
 * The daemon reads this table and writes only `TunnelState`; nothing
 * here is daemon-owned.
 */
const table = State.SQLite.table({
  name: 'TunnelConfig',
  columns,
})

type Table = typeof table

type TunnelConfigRow = (typeof table)['Type']

const tunnelConfigSet = Events.clientOnly({
  name: 'v1.TunnelConfigSet',
  schema: Schema.Struct({
    subdomain: Schema.optional(Schema.NullOr(Schema.String)),
    rootDomain: Schema.optional(Schema.NullOr(Schema.String)),
    localPort: Schema.optional(Schema.NullOr(Schema.Number)),
    requestedRunning: Schema.optional(Schema.Boolean),
  }),
})

type EventsRecord = {
  tunnelConfigSet: typeof tunnelConfigSet
}

const events: EventsRecord = { tunnelConfigSet } as const

type ConflictTarget = Parameters<ReturnType<typeof table.insert>['onConflict']>[0]
// `ConflictTarget` is a column-name union tagged with the table's internal
// brand info, so the bare `'id'` literal can't satisfy it. Same workaround
// used in `apps-core/src/livestore/app-selection.ts` and
// `emr-core/src/internal/domain-resource-persistence.ts`.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const idConflictColumn = 'id' as unknown as ConflictTarget

const materializers = State.SQLite.materializers(events, {
  // Patch semantics: omitted fields preserve prior values. On a fresh
  // install (no row yet) the omitted fields fall back to the column
  // defaults — `requestedRunning: false`, everything else null.
  'v1.TunnelConfigSet': ({ subdomain, rootDomain, localPort, requestedRunning }, { query }) => {
    const existing = query(table.where({ id: TUNNEL_CONFIG_ID }))[0]
    return table
      .insert({
        id: TUNNEL_CONFIG_ID,
        subdomain: subdomain !== undefined ? subdomain : (existing?.subdomain ?? null),
        rootDomain: rootDomain !== undefined ? rootDomain : (existing?.rootDomain ?? null),
        localPort: localPort !== undefined ? localPort : (existing?.localPort ?? null),
        requestedRunning:
          requestedRunning !== undefined ? requestedRunning : (existing?.requestedRunning ?? false),
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
