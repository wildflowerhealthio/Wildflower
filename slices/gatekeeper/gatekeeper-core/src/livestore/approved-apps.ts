import { Events, queryDb, State } from '@livestore/livestore'
import { pipe, Schema } from 'effect'

const ApprovedAppIdSchema = pipe(Schema.String, Schema.brand('ApprovedApp/id'))

const table = State.SQLite.table({
  name: 'approvedApps',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    clientId: State.SQLite.text(),
    type: State.SQLite.text(), // 'oauth' | 'ip'
    scopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    redirectUri: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    approvedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    lastAccessedAt: State.SQLite.json({ schema: Schema.NullOr(Schema.DateTimeUtc) }),
    label: State.SQLite.text(),
    patient: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
  },
})

type ApprovedAppRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'approvedApps' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows) => rows[0],
      label: 'approvedAppById',
    }),
  byClientId$: (clientId: string) =>
    queryDb(table.where({ clientId }), {
      label: 'approvedAppByClientId',
    }),
}

const events = {
  appApproved: Events.synced({
    name: 'v1.AppApproved',
    schema: Schema.Struct({
      id: ApprovedAppIdSchema,
      clientId: Schema.String,
      type: Schema.Literal('oauth', 'ip', 'pin'),
      scopes: Schema.Array(Schema.String),
      redirectUri: Schema.optionalWith(Schema.String, { default: () => '' }),
      approvedAt: Schema.DateTimeUtc,
      label: Schema.String,
      patient: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
    }),
  }),
  appRevoked: Events.synced({
    name: 'v1.AppRevoked',
    schema: Schema.Struct({ id: ApprovedAppIdSchema }),
  }),
  appAccessRecorded: Events.synced({
    name: 'v1.AppAccessRecorded',
    schema: Schema.Struct({
      id: ApprovedAppIdSchema,
      lastAccessedAt: Schema.DateTimeUtc,
    }),
  }),
} as const

const materializers = {
  'v1.AppApproved': ({
    id,
    clientId,
    type,
    scopes,
    redirectUri,
    approvedAt,
    label,
    patient,
  }: typeof events.appApproved.schema.Type) =>
    table.insert({
      id,
      clientId,
      type,
      scopes,
      redirectUri: redirectUri || null,
      approvedAt,
      lastAccessedAt: null,
      label,
      patient: patient ?? null,
    }),
  'v1.AppRevoked': ({ id }: typeof events.appRevoked.schema.Type) => table.delete().where({ id }),
  'v1.AppAccessRecorded': ({ id, lastAccessedAt }: typeof events.appAccessRecorded.schema.Type) =>
    table.update({ lastAccessedAt }).where({ id }),
}

export { ApprovedAppIdSchema, table, queries, events, materializers }
export type { ApprovedAppRow }
