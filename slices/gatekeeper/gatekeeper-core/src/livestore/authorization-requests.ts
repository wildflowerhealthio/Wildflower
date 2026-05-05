import { Events, queryDb, State } from '@livestore/livestore'
import { DateTime, Schema } from 'effect'

const table = State.SQLite.table({
  name: 'authorizationRequests',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    clientId: State.SQLite.text(),
    requestedScopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    codeChallenge: State.SQLite.text(),
    codeChallengeMethod: State.SQLite.text(),
    redirectUri: State.SQLite.text(),
    clientState: State.SQLite.text(),
    preApprovedScopes: State.SQLite.json({ schema: Schema.NullOr(Schema.Array(Schema.String)) }),
    requestedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    expiresAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    status: State.SQLite.text(), // 'pending' | 'approved' | 'denied' | 'expired'
    grantedScopes: State.SQLite.json({ schema: Schema.NullOr(Schema.Array(Schema.String)) }),
    patient: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
  },
})

type AuthorizationRequestRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'authorizationRequests' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows): AuthorizationRequestRow | null => rows[0] ?? null,
      label: 'authorizationRequestById',
    }),
  allExpired$: (now: DateTime.Utc) =>
    queryDb(table, {
      map: (rows): readonly AuthorizationRequestRow[] =>
        rows.filter((row) => DateTime.lessThan(row.expiresAt, now)),
      label: 'authorizationRequestsExpired',
    }),
}

const events = {
  authorizationRequestStarted: Events.synced({
    name: 'v1.AuthorizationRequestStarted',
    schema: Schema.Struct({
      id: Schema.String,
      clientId: Schema.String,
      requestedScopes: Schema.Array(Schema.String),
      codeChallenge: Schema.String,
      codeChallengeMethod: Schema.String,
      redirectUri: Schema.String,
      clientState: Schema.String,
      preApprovedScopes: Schema.NullOr(Schema.Array(Schema.String)),
      requestedAt: Schema.DateTimeUtc,
      expiresAt: Schema.DateTimeUtc,
    }),
  }),
  authorizationRequestApproved: Events.synced({
    name: 'v1.AuthorizationRequestApproved',
    schema: Schema.Struct({
      id: Schema.String,
      grantedScopes: Schema.Array(Schema.String),
      patient: Schema.NullOr(Schema.String),
    }),
  }),
  authorizationRequestDenied: Events.synced({
    name: 'v1.AuthorizationRequestDenied',
    schema: Schema.Struct({ id: Schema.String }),
  }),
  authorizationRequestExpired: Events.synced({
    name: 'v1.AuthorizationRequestExpired',
    schema: Schema.Struct({ id: Schema.String }),
  }),
} as const

const materializers = {
  'v1.AuthorizationRequestStarted': ({
    id,
    clientId,
    requestedScopes,
    codeChallenge,
    codeChallengeMethod,
    redirectUri,
    clientState,
    preApprovedScopes,
    requestedAt,
    expiresAt,
  }: typeof events.authorizationRequestStarted.schema.Type) =>
    table.insert({
      id,
      clientId,
      requestedScopes,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      clientState,
      preApprovedScopes,
      requestedAt,
      expiresAt,
      status: 'pending',
      grantedScopes: null,
      patient: null,
    }),
  'v1.AuthorizationRequestApproved': ({
    id,
    grantedScopes,
    patient,
  }: typeof events.authorizationRequestApproved.schema.Type) =>
    table.update({ status: 'approved', grantedScopes, patient }).where({ id }),
  'v1.AuthorizationRequestDenied': ({ id }: typeof events.authorizationRequestDenied.schema.Type) =>
    table.update({ status: 'denied' }).where({ id }),
  'v1.AuthorizationRequestExpired': ({
    id,
  }: typeof events.authorizationRequestExpired.schema.Type) =>
    table.update({ status: 'expired' }).where({ id }),
}

export { table, queries, events, materializers }
export type { AuthorizationRequestRow }
