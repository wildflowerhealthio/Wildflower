import { queryDb, Schema, SessionIdSymbol, State, type LiveQueryDef } from '@livestore/livestore'

/** Shape of the per-session bootstrap-token row. */
type Table = State.SQLite.ClientDocumentTableDef<
  'BootstrapToken',
  {
    readonly token: string | null
  },
  {
    readonly token: string | null
  },
  {
    partialSet: true
    default: {
      id: typeof SessionIdSymbol
      value: {
        readonly token: null
      }
    }
  }
>

/**
 * Per-session host-owner bootstrap token row.
 *
 * Hosts that act as the owner (e.g. the Expo device app) mint a token
 * at boot via `mintHostOwnerToken` and commit it here so the SPA can
 * read it via `useQuery` and present it on first load — closing the
 * loop without a device-code round trip. The row is session-scoped
 * (`SessionIdSymbol`) so the token never persists across an OS-level
 * restart of the host process; a fresh boot mints a fresh token.
 *
 * `null` means "no host has minted yet" — either because the host
 * isn't the owner (node prod) or because the bootstrap pipeline is
 * still in flight.
 */
const table: Table = State.SQLite.clientDocument({
  name: 'BootstrapToken',
  schema: Schema.Struct({
    token: Schema.NullOr(Schema.String),
  }),
  default: {
    id: SessionIdSymbol,
    value: { token: null },
  },
})

/** Shape of this slice's livestore events record. */
type Events = {
  bootstrapTokenSet: Table['set']
}

const events = {
  bootstrapTokenSet: table.set,
} as const

/** This slice has no materializers — the `clientDocument` writes its own row. */
type Materializers = object

const materializers = {} as const

/** Live query of the per-session bootstrap-token row. */
const current$ = queryDb(table.get(SessionIdSymbol), { label: 'bootstrapToken' })

/** Shape of this slice's livestore queries record. */
type Queries = {
  current$: LiveQueryDef<
    {
      readonly token: string | null
    },
    'def'
  >
}

const queries: Queries = { current$ } as const

export { events, materializers, queries, table }
export type { Events, Materializers, Queries, Table }
