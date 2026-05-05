import { Events, queryDb, State } from '@livestore/livestore'
import { DateTime, Schema } from 'effect'

const table = State.SQLite.table({
  name: 'authorizationCodes',
  columns: {
    code: State.SQLite.text({ primaryKey: true }),
    requestId: State.SQLite.text(),
    clientId: State.SQLite.text(),
    redirectUri: State.SQLite.text(),
    codeChallenge: State.SQLite.text(),
    grantedScopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    patient: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
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
  allExpired$: (now: DateTime.Utc) =>
    queryDb(table, {
      map: (rows): readonly AuthorizationCodeRow[] =>
        rows.filter((row) => DateTime.lessThan(row.expiresAt, now)),
      label: 'authorizationCodesExpired',
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
  // Bulk-expire event: cleanup pass commits one event with all expired
  // codes in the payload. Replicas converge because the codes list is
  // deterministic (computed by the cleanup Effect from a snapshot read).
  authorizationCodesExpiredAsOf: Events.synced({
    name: 'v1.AuthorizationCodesExpiredAsOf',
    schema: Schema.Struct({ codes: Schema.Array(Schema.String) }),
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
  'v1.AuthorizationCodesExpiredAsOf': ({
    codes,
  }: typeof events.authorizationCodesExpiredAsOf.schema.Type) =>
    codes.map((code) => table.delete().where({ code })),
}

export { table, queries, events, materializers }
export type { AuthorizationCodeRow }
