import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

const table = State.SQLite.table({
  name: 'authorizationCodes',
  columns: {
    code: State.SQLite.text({ primaryKey: true }),
    requestId: State.SQLite.text(),
    clientId: State.SQLite.text(),
    redirectUri: State.SQLite.text(),
    codeChallenge: State.SQLite.text(),
    grantedScopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    patient: State.SQLite.text({ nullable: true }),
    issuedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    expiresAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
  },
})

type AuthorizationCodeRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'authorizationCodes' }),
  byCode$: (code: string) =>
    queryDb(table.where({ code }), {
      map: (rows): AuthorizationCodeRow | null => rows[0] ?? null,
      label: 'authorizationCodeByCode',
    }),
  byRequestId$: (requestId: string) =>
    queryDb(table.where({ requestId }), {
      map: (rows): AuthorizationCodeRow | null => rows[0] ?? null,
      label: 'authorizationCodeByRequestId',
    }),
}

const events = {
  authorizationCodeIssued: Events.synced({
    name: 'v1.AuthorizationCodeIssued',
    schema: Schema.Struct({
      code: Schema.String,
      requestId: Schema.String,
      clientId: Schema.String,
      redirectUri: Schema.String,
      codeChallenge: Schema.String,
      grantedScopes: Schema.Array(Schema.String),
      patient: Schema.NullOr(Schema.String),
      issuedAt: Schema.DateTimeUtc,
      expiresAt: Schema.DateTimeUtc,
    }),
  }),
  authorizationCodeConsumed: Events.synced({
    name: 'v1.AuthorizationCodeConsumed',
    schema: Schema.Struct({ code: Schema.String }),
  }),
  // Bulk-delete pass: remove every code whose `expiresAt` is on-or-before
  // `expiredBefore`. Carries a single timestamp instead of a row-id list
  // so replicas converge purely on the cutoff — no risk of two cleanup
  // passes building diverging id sets between snapshot read and commit.
  deleteAuthorizationCodesExpiredAsOf: Events.synced({
    name: 'v1.DeleteAuthorizationCodesExpiredAsOf',
    schema: Schema.Struct({ expiredBefore: Schema.DateTimeUtc }),
  }),
} as const

const materializers = {
  'v1.AuthorizationCodeIssued': ({
    code,
    requestId,
    clientId,
    redirectUri,
    codeChallenge,
    grantedScopes,
    patient,
    issuedAt,
    expiresAt,
  }: typeof events.authorizationCodeIssued.schema.Type) =>
    table.insert({
      code,
      requestId,
      clientId,
      redirectUri,
      codeChallenge,
      grantedScopes,
      patient,
      issuedAt,
      expiresAt,
    }),
  'v1.AuthorizationCodeConsumed': ({ code }: typeof events.authorizationCodeConsumed.schema.Type) =>
    table.delete().where({ code }),
  'v1.DeleteAuthorizationCodesExpiredAsOf': ({
    expiredBefore,
  }: typeof events.deleteAuthorizationCodesExpiredAsOf.schema.Type) =>
    table.delete().where({ expiresAt: { op: '<=', value: expiredBefore } }),
}

export { table, queries, events, materializers }
export type { AuthorizationCodeRow }
