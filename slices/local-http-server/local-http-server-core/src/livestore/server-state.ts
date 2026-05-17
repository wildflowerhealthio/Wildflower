import { queryDb, Schema, SessionIdSymbol, State, type LiveQueryDef } from '@livestore/livestore'

type Table = State.SQLite.ClientDocumentTableDef<
  'LocalHttpServerState',
  {
    readonly requestedRunning: boolean
    readonly running: boolean
    readonly localOrigin: string
    readonly port: number
  },
  {
    readonly requestedRunning: boolean
    readonly running: boolean
    readonly localOrigin: string
    readonly port: number
  },
  {
    partialSet: true
    default: {
      id: typeof SessionIdSymbol
      value: {
        readonly requestedRunning: false
        readonly running: false
        readonly localOrigin: 'http://127.0.0.1:8080'
        readonly port: 8080
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
    localOrigin: Schema.String,
    port: Schema.Number,
  }),
  default: {
    id: SessionIdSymbol,
    value: {
      requestedRunning: false,
      running: false,
      localOrigin: 'http://127.0.0.1:8080',
      port: 8080,
    },
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
      readonly localOrigin: string
      readonly port: number
    },
    'def'
  >
}

const queries: Queries = { current$ } as const

export { events, materializers, queries, table }
export type { Table, Events, Materializers, Queries }
