import { queryDb, Schema, SessionIdSymbol, State } from '@livestore/livestore'

/**
 * Per-session HTTP-server state. `requestedRunning` is the caller's
 * intent; `running` / `localOrigin` / `port` are written by the daemon
 * once the server has actually bound the port (or cleared on teardown).
 */
const table = State.SQLite.clientDocument({
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

const events = {
  localHttpServerStateSet: table.set,
} as const

const materializers = {} as const

const current$ = queryDb(table.get(SessionIdSymbol), { label: 'localHttpServerState' })

const queries = { current$ } as const

export { events, materializers, queries, table }
