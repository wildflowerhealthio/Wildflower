import { Events, queryDb, State } from '@livestore/livestore'
import { DateTime, Schema } from 'effect'

const AuthorizationFlowSchema = Schema.Literal('authorization_code', 'device_code')

type AuthorizationFlow = typeof AuthorizationFlowSchema.Type

const table = State.SQLite.table({
  name: 'authorizationRequests',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    flow: State.SQLite.json({ schema: AuthorizationFlowSchema }),
    clientId: State.SQLite.text(),
    requestedScopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    codeChallenge: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    codeChallengeMethod: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    redirectUri: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    clientState: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    userCode: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
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
  byUserCode$: (userCode: string) =>
    queryDb(table.where({ userCode }), {
      map: (rows): AuthorizationRequestRow | null => rows[0] ?? null,
      label: 'authorizationRequestByUserCode',
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
  deviceAuthorizationRequestStarted: Events.synced({
    name: 'v1.DeviceAuthorizationRequestStarted',
    schema: Schema.Struct({
      id: Schema.String,
      clientId: Schema.String,
      requestedScopes: Schema.Array(Schema.String),
      userCode: Schema.String,
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
      flow: 'authorization_code',
      clientId,
      requestedScopes,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      clientState,
      userCode: null,
      preApprovedScopes,
      requestedAt,
      expiresAt,
      status: 'pending',
      grantedScopes: null,
      patient: null,
    }),
  'v1.DeviceAuthorizationRequestStarted': ({
    id,
    clientId,
    requestedScopes,
    userCode,
    requestedAt,
    expiresAt,
  }: typeof events.deviceAuthorizationRequestStarted.schema.Type) =>
    table.insert({
      id,
      flow: 'device_code',
      clientId,
      requestedScopes,
      codeChallenge: null,
      codeChallengeMethod: null,
      redirectUri: null,
      clientState: null,
      userCode,
      preApprovedScopes: null,
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

export { AuthorizationFlowSchema, table, queries, events, materializers }
export type { AuthorizationFlow, AuthorizationRequestRow }
