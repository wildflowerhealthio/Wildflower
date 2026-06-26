import { queryDb, Schema, SessionIdSymbol, State, type LiveQueryDef } from '@livestore/livestore'

/** Shape of the per-session local-client token row. */
type Table = State.SQLite.ClientDocumentTableDef<
  'LocalClientToken',
  {
    readonly value: string | null
  },
  {
    readonly value: string | null
  },
  {
    partialSet: true
    default: {
      id: typeof SessionIdSymbol
      value: {
        readonly value: null
      }
    }
  }
>

/**
 * Per-session bearer token for the first-party OAuth client that lives
 * in the same process as the gatekeeper (the `wildflower-host` client
 * registered by `seedFirstPartyClient`).
 *
 * Hosts that act as the owner mint a
 * token at boot via `mintHostOwnerToken` and commit it here so the
 * embedded SPA can `useQuery` the row on first paint and authenticate
 * without a device-code round trip. The token can rotate during a
 * session (e.g. when the gatekeeper re-issues), so consumers should
 * keep observing rather than reading once.
 *
 * `null` means "no live token" — either the host isn't the owner (node
 * prod), the mint failed at bootstrap, or bootstrap is still in flight.
 * The row is session-scoped (`SessionIdSymbol`), so a fresh process
 * always starts at `null` and a successful mint flips it to a string.
 */
const table: Table = State.SQLite.clientDocument({
  name: 'LocalClientToken',
  schema: Schema.Struct({
    value: Schema.NullOr(Schema.String),
  }),
  default: {
    id: SessionIdSymbol,
    value: { value: null },
  },
})

/** Shape of this slice's livestore events record. */
type Events = {
  localClientTokenSet: Table['set']
}

const events = {
  localClientTokenSet: table.set,
} as const

/** This slice has no materializers — the `clientDocument` writes its own row. */
type Materializers = object

const materializers = {} as const

/** Live query of the per-session local-client token row. */
const current$ = queryDb(table.get(SessionIdSymbol), { label: 'localClientToken' })

/** Shape of this slice's livestore queries record. */
type Queries = {
  current$: LiveQueryDef<
    {
      readonly value: string | null
    },
    'def'
  >
}

const queries: Queries = { current$ } as const

export { events, materializers, queries, table }
export type { Events, Materializers, Queries, Table }
