import { queryDb, Schema, SessionIdSymbol, State, type LiveQueryDef } from '@livestore/livestore'

/**
 * Port used when no server is bound. Surfaces in the UI as the "idle"
 * value and is the default the daemon starts from.
 */
const DEFAULT_IDLE_PORT = 8080

/**
 * Loopback origin paired with {@link DEFAULT_IDLE_PORT} as the idle
 * default for the `localOrigin` field.
 */
const DEFAULT_LOCAL_ORIGIN = `http://127.0.0.1:${DEFAULT_IDLE_PORT}` as const

/** Shape of the per-session local-HTTP-server state table. */
type Table = State.SQLite.ClientDocumentTableDef<
  'LocalHttpServerState',
  {
    readonly requestedRunning: boolean
    readonly running: boolean
    readonly localOrigin: string
    readonly port: number
    readonly error: string | null
  },
  {
    readonly requestedRunning: boolean
    readonly running: boolean
    readonly localOrigin: string
    readonly port: number
    readonly error: string | null
  },
  {
    partialSet: true
    default: {
      id: typeof SessionIdSymbol
      value: {
        readonly requestedRunning: false
        readonly running: false
        readonly localOrigin: typeof DEFAULT_LOCAL_ORIGIN
        readonly port: typeof DEFAULT_IDLE_PORT
        readonly error: null
      }
    }
  }
>

/**
 * Per-session HTTP-server state. `requestedRunning` is the caller's
 * intent; `running` / `localOrigin` / `port` are written by the daemon
 * once the server has actually bound the port (or cleared on teardown).
 * `error` carries the last `startServer` failure (with `running: false`
 * and `requestedRunning: true` preserved) so the UI can surface it.
 */
const table: Table = State.SQLite.clientDocument({
  name: 'LocalHttpServerState',
  schema: Schema.Struct({
    requestedRunning: Schema.Boolean,
    running: Schema.Boolean,
    localOrigin: Schema.String,
    port: Schema.Number,
    error: Schema.NullOr(Schema.String),
  }),
  default: {
    id: SessionIdSymbol,
    value: {
      requestedRunning: false,
      running: false,
      localOrigin: DEFAULT_LOCAL_ORIGIN,
      port: DEFAULT_IDLE_PORT,
      error: null,
    },
  },
})

/** Shape of this slice's livestore events record. */
type Events = {
  localHttpServerStateSet: Table['set']
}

const events = {
  localHttpServerStateSet: table.set,
} as const

/** This slice has no materializers — the `clientDocument` writes its own row. */
type Materializers = object

const materializers = {} as const

/** Live query of the per-session HTTP-server state row. */
const current$ = queryDb(table.get(SessionIdSymbol), { label: 'localHttpServerState' })

/** Shape of this slice's livestore queries record. */
type Queries = {
  current$: LiveQueryDef<
    {
      readonly requestedRunning: boolean
      readonly running: boolean
      readonly localOrigin: string
      readonly port: number
      readonly error: string | null
    },
    'def'
  >
}

const queries: Queries = { current$ } as const

export { DEFAULT_IDLE_PORT, DEFAULT_LOCAL_ORIGIN, events, materializers, queries, table }
export type { Events, Materializers, Queries, Table }
