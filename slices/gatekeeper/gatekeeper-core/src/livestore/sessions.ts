import { Events, queryDb, State } from '@livestore/livestore'
import { pipe, Schema } from 'effect'

const SessionIdSchema = pipe(Schema.String, Schema.brand('Session/id'))

const SessionDurationSchema = Schema.Literal('request', '1min', '15min')

type SessionDuration = typeof SessionDurationSchema.Type

const table = State.SQLite.table({
  name: 'sessions',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    startedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    expiresAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    duration: State.SQLite.json({ schema: SessionDurationSchema }),
    label: State.SQLite.text(),
  },
})

type SessionRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'sessions' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows): SessionRow | null => rows[0] ?? null,
      label: 'sessionById',
    }),
}

const events = {
  sessionStarted: Events.synced({
    name: 'v1.SessionStarted',
    schema: Schema.Struct({
      id: SessionIdSchema,
      startedAt: Schema.DateTimeUtc,
      expiresAt: Schema.DateTimeUtc,
      duration: SessionDurationSchema,
      label: Schema.String,
    }),
  }),
  sessionEnded: Events.synced({
    name: 'v1.SessionEnded',
    schema: Schema.Struct({ id: SessionIdSchema }),
  }),
} as const

const materializers = {
  'v1.SessionStarted': ({
    id,
    startedAt,
    expiresAt,
    duration,
    label,
  }: typeof events.sessionStarted.schema.Type) =>
    table.insert({ id, startedAt, expiresAt, duration, label }),
  'v1.SessionEnded': ({ id }: typeof events.sessionEnded.schema.Type) =>
    table.delete().where({ id }),
}

export { SessionIdSchema, SessionDurationSchema, table, queries, events, materializers }
export type { SessionRow, SessionDuration }
