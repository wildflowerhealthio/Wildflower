import { queryDb, Schema, SessionIdSymbol, State } from '@livestore/livestore'

/** Shape of the per-session, daemon-owned tunnel-state table. */
type Table = State.SQLite.ClientDocumentTableDef<
  'TunnelState',
  {
    readonly running: boolean
    readonly currentSubdomain: string | null
    readonly currentRootDomain: string | null
    readonly currentLocalPort: number | null
    readonly error: string | null
  },
  {
    readonly running: boolean
    readonly currentSubdomain: string | null
    readonly currentRootDomain: string | null
    readonly currentLocalPort: number | null
    readonly error: string | null
  },
  {
    partialSet: true
    default: {
      id: typeof SessionIdSymbol
      value: {
        readonly running: false
        readonly currentSubdomain: null
        readonly currentRootDomain: null
        readonly currentLocalPort: null
        readonly error: null
      }
    }
  }
>

/**
 * Per-session tunnel state — daemon-owned. `running` is the daemon's
 * observed truth (mirrors `LocalHttpServerState.running`); the `current*`
 * fields reflect what the upstream relay actually granted (may differ
 * from `TunnelConfig` if the relay refuses the requested subdomain).
 * `error` carries the last `startTunnel` failure with
 * `requestedRunning: true` preserved in `TunnelConfig` so the UI can
 * surface it.
 *
 * Resets each session — the daemon re-derives `running` etc. on boot
 * from `TunnelConfig.requestedRunning`.
 */
const table: Table = State.SQLite.clientDocument({
  name: 'TunnelState',
  schema: Schema.Struct({
    running: Schema.Boolean,
    currentSubdomain: Schema.NullOr(Schema.String),
    currentRootDomain: Schema.NullOr(Schema.String),
    currentLocalPort: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.String),
  }),
  default: {
    id: SessionIdSymbol,
    value: {
      running: false,
      currentSubdomain: null,
      currentRootDomain: null,
      currentLocalPort: null,
      error: null,
    },
  },
})

/** Shape of this slice's session-state events record. */
type Events = {
  tunnelStateSet: Table['set']
}

const events: Events = {
  tunnelStateSet: table.set,
} as const

/** This table has no materializers — the `clientDocument` writes its own row. */
type Materializers = object

const materializers: Materializers = {} as const

/** Live query of the per-session tunnel-state row. */
const current$ = queryDb(table.get(SessionIdSymbol), { label: 'tunnelState' })

/** Shape of this table's queries record. */
type Queries = {
  current$: typeof current$
}

const queries: Queries = { current$ } as const

export { events, materializers, queries, table }
export type { Events, Materializers, Queries, Table }
