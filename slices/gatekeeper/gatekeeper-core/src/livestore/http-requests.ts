import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

const table = State.SQLite.table({
  name: 'httpRequests',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    method: State.SQLite.text(),
    url: State.SQLite.text(),
    origin: State.SQLite.text(),
    userAgent: State.SQLite.text(),
    requestedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    status: State.SQLite.text(), // 'pending' | 'approved' | 'rejected'
    statusCode: State.SQLite.json({ schema: Schema.NullOr(Schema.Int) }),
    respondedAt: State.SQLite.json({ schema: Schema.NullOr(Schema.DateTimeUtc) }),
  },
})

type HttpRequestRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'httpRequests' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows) => rows[0],
      label: 'httpRequestById',
    }),
  pending$: queryDb(table.where({ status: 'pending' }), { label: 'pendingHttpRequests' }),
}

const events = {
  httpRequestReceived: Events.synced({
    name: 'v1.HttpRequestReceived',
    schema: Schema.Struct({
      id: Schema.String,
      method: Schema.String,
      url: Schema.String,
      origin: Schema.String,
      userAgent: Schema.String,
      requestedAt: Schema.DateTimeUtc,
    }),
  }),
  httpRequestApproved: Events.synced({
    name: 'v1.HttpRequestApproved',
    schema: Schema.Struct({ id: Schema.String }),
  }),
  httpRequestRejected: Events.synced({
    name: 'v1.HttpRequestRejected',
    schema: Schema.Struct({
      id: Schema.String,
      respondedAt: Schema.DateTimeUtc,
    }),
  }),
  httpRequestResponded: Events.synced({
    name: 'v1.HttpRequestResponded',
    schema: Schema.Struct({
      id: Schema.String,
      statusCode: Schema.Int,
      respondedAt: Schema.DateTimeUtc,
    }),
  }),
} as const

const materializers = {
  'v1.HttpRequestReceived': ({
    id,
    method,
    url,
    origin,
    userAgent,
    requestedAt,
  }: typeof events.httpRequestReceived.schema.Type) =>
    table.insert({
      id,
      method,
      url,
      origin,
      userAgent,
      requestedAt,
      status: 'pending',
      statusCode: null,
      respondedAt: null,
    }),
  'v1.HttpRequestApproved': ({ id }: typeof events.httpRequestApproved.schema.Type) =>
    table.update({ status: 'approved' }).where({ id }),
  'v1.HttpRequestRejected': ({ id, respondedAt }: typeof events.httpRequestRejected.schema.Type) =>
    table.update({ status: 'rejected', statusCode: 403, respondedAt }).where({ id }),
  'v1.HttpRequestResponded': ({
    id,
    statusCode,
    respondedAt,
  }: typeof events.httpRequestResponded.schema.Type) =>
    table.update({ statusCode, respondedAt }).where({ id }),
}

export { table, queries, events, materializers }
export type { HttpRequestRow }
