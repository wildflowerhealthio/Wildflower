import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

// Maps to the OAuth `grant_type` request parameter (RFC 6749 §1.3, RFC
// 8628 §3.4). The URN `urn:ietf:params:oauth:grant-type:device_code`
// stored on the wire is shortened to `device_code` here; both names
// refer to the Device Authorization Grant.
const AuthorizationGrantTypeSchema = Schema.Literal('authorization_code', 'device_code')

type AuthorizationGrantType = typeof AuthorizationGrantTypeSchema.Type

// PKCE code-challenge method per RFC 7636 §4.2. Only `S256` is accepted;
// the deprecated `plain` method is rejected at the `Authorize` endpoint.
const CodeChallengeMethodSchema = Schema.Literal('S256')

type CodeChallengeMethod = typeof CodeChallengeMethodSchema.Type

const table = State.SQLite.table({
  name: 'authorizationRequests',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    grantType: State.SQLite.json({ schema: AuthorizationGrantTypeSchema }),
    clientId: State.SQLite.text(),
    requestedScopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    codeChallenge: State.SQLite.text({ nullable: true }),
    codeChallengeMethod: State.SQLite.json({
      schema: Schema.NullOr(CodeChallengeMethodSchema),
    }),
    redirectUri: State.SQLite.text({ nullable: true }),
    clientState: State.SQLite.text({ nullable: true }),
    userCode: State.SQLite.text({ nullable: true }),
    preApprovedScopes: State.SQLite.json({ schema: Schema.NullOr(Schema.Array(Schema.String)) }),
    requestedAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    expiresAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    lastPolledAt: State.SQLite.json({ schema: Schema.NullOr(Schema.DateTimeUtc) }),
    status: State.SQLite.text(), // 'pending' | 'approved' | 'denied' | 'expired'
    grantedScopes: State.SQLite.json({ schema: Schema.NullOr(Schema.Array(Schema.String)) }),
    patient: State.SQLite.text({ nullable: true }),
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
}

const events = {
  authorizationRequestStarted: Events.synced({
    name: 'v1.AuthorizationRequestStarted',
    schema: Schema.Struct({
      id: Schema.String,
      clientId: Schema.String,
      requestedScopes: Schema.Array(Schema.String),
      codeChallenge: Schema.String,
      codeChallengeMethod: CodeChallengeMethodSchema,
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
  // Bulk-delete pass: remove every request whose `expiresAt` is
  // on-or-before `expiredAfter`. Carries a single timestamp instead of a
  // row-id list so replicas converge purely on the cutoff.
  deleteAuthorizationRequestsExpiredAsOf: Events.synced({
    name: 'v1.DeleteAuthorizationRequestsExpiredAsOf',
    schema: Schema.Struct({ expiredAfter: Schema.DateTimeUtc }),
  }),
  deviceAuthorizationPolled: Events.synced({
    name: 'v1.DeviceAuthorizationPolled',
    schema: Schema.Struct({
      id: Schema.String,
      polledAt: Schema.DateTimeUtc,
    }),
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
      grantType: 'authorization_code',
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
      lastPolledAt: null,
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
      grantType: 'device_code',
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
      lastPolledAt: null,
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
  'v1.DeleteAuthorizationRequestsExpiredAsOf': ({
    expiredAfter,
  }: typeof events.deleteAuthorizationRequestsExpiredAsOf.schema.Type) =>
    table.delete().where({ expiresAt: { op: '<=', value: expiredAfter } }),
  'v1.DeviceAuthorizationPolled': ({
    id,
    polledAt,
  }: typeof events.deviceAuthorizationPolled.schema.Type) =>
    table.update({ lastPolledAt: polledAt }).where({ id }),
}

export {
  AuthorizationGrantTypeSchema,
  CodeChallengeMethodSchema,
  table,
  queries,
  events,
  materializers,
}
export type { AuthorizationGrantType, AuthorizationRequestRow, CodeChallengeMethod }
