import { queryDb, Schema, SessionIdSymbol, State, type LiveQueryDef } from '@livestore/livestore'

/** Shape of the per-session tunnel state table. */
type Table = State.SQLite.ClientDocumentTableDef<
  'TunnelState',
  {
    readonly requestedPublicOrigin: string | null
    readonly currentPublicOrigin: string | null
  },
  {
    readonly requestedPublicOrigin: string | null
    readonly currentPublicOrigin: string | null
  },
  {
    partialSet: true
    default: {
      id: typeof SessionIdSymbol
      value: {
        readonly requestedPublicOrigin: null
        readonly currentPublicOrigin: null
      }
    }
  }
>

/**
 * Per-session tunnel state.
 *
 * `requestedPublicOrigin` is the literal target URL the host wants the
 * device's HTTP server reachable at (commit e.g.
 * `https://wildflower-expo-dev.loca.lt` to ask the tunnel daemon to
 * acquire it; commit `null` to tear down).
 *
 * `currentPublicOrigin` is what the daemon actually got. The daemon
 * only writes it when the upstream grants exactly the requested URL —
 * anything else stays `null`.
 */
const table: Table = State.SQLite.clientDocument({
  name: 'TunnelState',
  schema: Schema.Struct({
    requestedPublicOrigin: Schema.NullOr(Schema.String),
    currentPublicOrigin: Schema.NullOr(Schema.String),
  }),
  default: {
    id: SessionIdSymbol,
    value: { requestedPublicOrigin: null, currentPublicOrigin: null },
  },
})

/** Shape of this slice's livestore events record. */
type Events = {
  tunnelStateSet: Table['set']
}

const events: Events = {
  tunnelStateSet: table.set,
} as const

/** This slice has no materializers — the `clientDocument` writes its own row. */
type Materializers = object

const materializers: Materializers = {} as const

/** Live query of the per-session tunnel-state row. */
const current$ = queryDb(table.get(SessionIdSymbol), { label: 'tunnelState' })

/** Shape of this slice's livestore queries record. */
type Queries = {
  current$: LiveQueryDef<
    {
      readonly requestedPublicOrigin: string | null
      readonly currentPublicOrigin: string | null
    },
    'def'
  >
}

const queries: Queries = { current$ } as const

export { events, materializers, queries, table }
export type { Events, Materializers, Queries, Table }
