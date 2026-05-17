import { queryDb, Schema, SessionIdSymbol, State, type LiveQueryDef } from '@livestore/livestore'

type Table = State.SQLite.ClientDocumentTableDef<
  'LocalHttpServerState',
  {
    readonly requestedRunning: boolean
    readonly running: boolean
    readonly localOrigin: string | null
    readonly port: number | null
  },
  {
    readonly requestedRunning: boolean
    readonly running: boolean
    readonly localOrigin: string | null
    readonly port: number | null
  },
  {
    partialSet: true
    default: {
      id: typeof SessionIdSymbol
      value: {
        readonly requestedRunning: false
        readonly running: false
        readonly localOrigin: null
        readonly port: null
      }
    }
  }
>

/**
 * Per-session HTTP-server state. `requestedRunning` is the caller's
 * intent; `running` / `localOrigin` / `port` are written by the daemon
 * once the server has actually bound the port (or cleared on teardown).
 */
const table: Table = State.SQLite.clientDocument({
  name: 'LocalHttpServerState',
  schema: Schema.Struct({
    requestedRunning: Schema.Boolean,
    running: Schema.Boolean,
    localOrigin: Schema.NullOr(Schema.String),
    port: Schema.NullOr(Schema.Number),
  }),
  default: {
    id: SessionIdSymbol,
    value: { requestedRunning: false, running: false, localOrigin: null, port: null },
  },
})

type Events = {
  localHttpServerStateSet: Table['set']
}

const events = {
  localHttpServerStateSet: table.set,
} as const

type Materializers = object

const materializers = {} as const

const current$ = queryDb(table.get(SessionIdSymbol), { label: 'localHttpServerState' })

type Queries = {
  current$: LiveQueryDef<
    {
      readonly requestedRunning: boolean
      readonly running: boolean
      readonly localOrigin: string | null
      readonly port: number | null
    },
    'def'
  >
}

const queries: Queries = { current$ } as const

export { events, materializers, queries, table }
export type { Table, Events, Materializers, Queries }
