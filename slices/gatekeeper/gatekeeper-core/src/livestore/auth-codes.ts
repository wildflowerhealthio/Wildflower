import { Events, queryDb, State } from '@livestore/livestore'
import { DateTime, Schema } from 'effect'

const table = State.SQLite.table({
  name: 'authCodes',
  columns: {
    code: State.SQLite.text({ primaryKey: true }),
    clientId: State.SQLite.text(),
    scope: State.SQLite.text(),
    codeChallenge: State.SQLite.text(),
    redirectUri: State.SQLite.text(),
    state: State.SQLite.text(),
    exp: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    status: State.SQLite.text(), // 'pending' | 'approved'
    approvedScopes: State.SQLite.json({ schema: Schema.NullOr(Schema.Array(Schema.String)) }),
    patient: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    preApprovedScopes: State.SQLite.json({ schema: Schema.NullOr(Schema.Array(Schema.String)) }),
  },
})

type AuthCodeRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'authCodes' }),
  byCode$: (code: string) =>
    queryDb(table.where({ code }), {
      map: (rows): AuthCodeRow | null => rows[0] ?? null,
      label: 'authCodeByCode',
    }),
  allExpired$: (now: DateTime.Utc) =>
    queryDb(table, {
      map: (rows): readonly AuthCodeRow[] => rows.filter((row) => DateTime.lessThan(row.exp, now)),
      label: 'authCodesExpired',
    }),
}

const events = {
  authCodeCreated: Events.synced({
    name: 'v1.AuthCodeCreated',
    schema: Schema.Struct({
      code: Schema.String,
      clientId: Schema.String,
      scope: Schema.String,
      codeChallenge: Schema.String,
      redirectUri: Schema.String,
      state: Schema.String,
      exp: Schema.DateTimeUtc,
      preApprovedScopes: Schema.NullOr(Schema.Array(Schema.String)),
    }),
  }),
  authCodeApproved: Events.synced({
    name: 'v1.AuthCodeApproved',
    schema: Schema.Struct({
      code: Schema.String,
      approvedScopes: Schema.Array(Schema.String),
      patient: Schema.NullOr(Schema.String),
    }),
  }),
  authCodeDeleted: Events.synced({
    name: 'v1.AuthCodeDeleted',
    schema: Schema.Struct({
      code: Schema.String,
    }),
  }),
} as const

const materializers = {
  'v1.AuthCodeCreated': ({
    code,
    clientId,
    scope,
    codeChallenge,
    redirectUri,
    state,
    exp,
    preApprovedScopes,
  }: typeof events.authCodeCreated.schema.Type) =>
    table.insert({
      code,
      clientId,
      scope,
      codeChallenge,
      redirectUri,
      state,
      exp,
      status: 'pending',
      approvedScopes: null,
      patient: null,
      preApprovedScopes,
    }),
  'v1.AuthCodeApproved': ({
    code,
    approvedScopes,
    patient,
  }: typeof events.authCodeApproved.schema.Type) =>
    table
      .update({
        status: 'approved',
        approvedScopes,
        patient,
        scope: approvedScopes.join(' '),
      })
      .where({ code }),
  'v1.AuthCodeDeleted': ({ code }: typeof events.authCodeDeleted.schema.Type) =>
    table.delete().where({ code }),
}

export { table, queries, events, materializers }
export type { AuthCodeRow }
