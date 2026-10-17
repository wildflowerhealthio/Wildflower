import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { InsufficientScopeSchema } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Schema } from 'effect'

import { Client } from '../domain/index.ts'
import { RequireAuthMiddleware } from './require-auth.ts'
/**
 * A `Grant` is a materialized consent decision — the Owner approved a client for
 * a scope set at a point in time — that survives across requests so the client
 * isn't re-approved on every call. It's **polymorphic** (a discriminated union on
 * `grantType`), mirroring the server's per-variant grant tables behind a `grants`
 * `UNION ALL` view 1:1 (see the authorization-core README):
 *
 * - `authorization_code` — an OAuth code-flow grant, carrying the exact
 *   `redirectUri` it covers ("Approved Apps");
 * - `device_code` — an RFC 8628 device pairing, carrying the paired `deviceName`
 *   ("Authorized Devices").
 *
 * A consumer narrows on `grantType` to read `redirectUri` (code) or `deviceName`
 * (device). `lastUsedAt` is null until the first time a token minted from this
 * grant is used.
 */
const sharedGrantFields = {
  id: Schema.String,
  clientId: Schema.String,
  scopes: Schema.Array(Schema.String),
  grantedAt: Schema.DateTimeUtc,
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtc),
  patient: Schema.NullOr(Schema.String),
} as const

/** A code-flow grant — carries the exact `redirectUri` the consent covers. */
const AuthorizationCodeGrantSchema = Schema.Struct({
  ...sharedGrantFields,
  grantType: Schema.Literal('authorization_code'),
  redirectUri: Schema.String,
})

/** A device-code grant — carries the paired device's `deviceName`. */
const DeviceGrantSchema = Schema.Struct({
  ...sharedGrantFields,
  grantType: Schema.Literal('device_code'),
  deviceName: Schema.String,
})

const GrantSchema = Schema.Union(AuthorizationCodeGrantSchema, DeviceGrantSchema)

const GrantsSchema = Schema.Array(GrantSchema)

const GrantNotFoundSchema = Schema.Struct({
  error: Schema.Literal('GrantNotFound'),
  id: Schema.String,
})

/** Every client the server trusts: `ListClients`' answer. */
const ClientsSchema = Schema.Array(Client.Schema)

/**
 * `UpdateClient`'s body — the one client field the Owner can edit.
 *
 * `disabledAt` is required, `null` included:
 * - any time disables the client now. The server stamps its own now whatever
 *   time is sent, so a disable can be neither scheduled nor backdated
 *   (Wildflower Authorization sends its current time).
 * - `null` re-enables it.
 *
 * A client that already has a `disabledAt` keeps it: disabling it again
 * doesn't move the time.
 */
const UpdateClientSchema = Schema.Struct({
  disabledAt: Schema.NullOr(Schema.DateTimeUtc),
})

const ClientNotFoundSchema = Schema.Struct({
  error: Schema.Literal('ClientNotFound'),
  clientId: Schema.String,
})

/**
 * `UpdateClient`'s `409` for disabling an essential client — the Wildflower
 * host app's or the browser-session client — which would leave the Owner no way
 * in.
 */
const EssentialClientSchema = Schema.Struct({
  error: Schema.Literal('EssentialClient'),
  clientId: Schema.String,
})

/**
 * `CreateRevocation`'s body: what to revoke, in exactly one of two modes.
 *
 * - `{ subject }` revokes every token the subject holds that was issued up to
 *   now. The subject is a token's `sub`, which is the `client_id`.
 * - `{ jti, expiresAt }` denylists one token until its own expiry.
 */
const RevocationSchema = Schema.Union(
  Schema.Struct({ subject: Schema.String }),
  Schema.Struct({ jti: Schema.String, expiresAt: Schema.DateTimeUtc })
)

/**
 * `400` from `CreateRevocation` for a body that names neither mode, both, or a
 * `jti` without its `expiresAt` (or with one already past).
 */
const RevocationRejectedSchema = Schema.Struct({
  error: Schema.Literal(
    'EmptyRevocation',
    'AmbiguousRevocation',
    'MissingExpiresAt',
    'ExpiresAtInPast'
  ),
  detail: Schema.String,
})

/**
 * What the caller's *current* access token carries — just the `scope` claim,
 * already split into scopes. Not the whole claim set: `jti`/`iss`/`aud`/`patient`
 * are session plumbing no caller has asked for, and leaving them off keeps
 * `GetSession` from drifting into a general introspection endpoint.
 */
const SessionSchema = Schema.Struct({
  scopes: Schema.Array(Schema.String),
})

/**
 * A live browser session: a browser the server has signed in, neither revoked
 * nor expired, keyed by the `sid` every token, code and refresh family minted
 * under it records.
 *
 * - `kind` is how the browser came to hold it: `owner`, a same-device sign-in
 *   as the Owner, or `approved`, a browser that paired at `/oauth/pair` with a
 *   code the Owner approved;
 * - `name` is the name an approved browser was given, `null` for an Owner
 *   browser;
 * - `lastSeenAt` is when it was last seen in use: its sign-in, the server
 *   accepting its cookie (at most once every five minutes), or a refresh-token
 *   family made under it rotating;
 * - `heldByCaller` is whether the caller's own token was minted under it.
 */
const BrowserSessionSchema = Schema.Struct({
  sid: Schema.String,
  kind: Schema.Literal('owner', 'approved'),
  name: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  heldByCaller: Schema.Boolean,
})

/** Every live browser session: `ListBrowserSessions`' answer. */
const BrowserSessionsSchema = Schema.Array(BrowserSessionSchema)

/** `RevokeBrowserSession`'s `404` for a `sid` that names no live session. */
const BrowserSessionNotFoundSchema = Schema.Struct({
  error: Schema.Literal('BrowserSessionNotFound'),
  sid: Schema.String,
})

/**
 * Owner-only operator surface. Every endpoint here carries
 * `RequireAuthMiddleware` so the slice's `-core` layer cannot ship them
 * unauthenticated by accident.
 *
 * Endpoint roles:
 * - `ListGrants` / `GetGrant` / `RevokeGrant`: read or revoke previously
 *   recorded consent decisions. Revoking a Grant means the next
 *   `/oauth/authorize` for that `(clientId, redirectUri)` will hit the
 *   consent UI again instead of auto-approving.
 * - `ListClients` / `UpdateClient`: see every client the Owner trusts and take
 *   that trust back (or restore it) by setting its `disabledAt`. Idempotent;
 *   disabling an essential client is a `409`.
 * - `CreateRevocation`: revoke issued tokens now — a subject's whole cohort,
 *   or one token by `jti`.
 * - `ListBrowserSessions` / `RevokeBrowserSession`: see every browser the
 *   server has signed in and end one, which ends everything minted under it.
 *   Revoking the caller's own session is allowed, and signs that browser out.
 * - `GetSession`: the caller reading back *their own* token's scopes. The
 *   odd one out — self-service rather than operator, and deliberately
 *   ungated by any scope on the server, since the sessions that need it
 *   most are the under-scoped ones an admin gate would lock out.
 */
const httpApiGroup = HttpApiGroup.make('access-management', { topLevel: false })
  .add(HttpApiEndpoint.get('GetSession', '/session').addSuccess(SessionSchema))
  .add(HttpApiEndpoint.get('ListGrants', '/grants').addSuccess(GrantsSchema))
  .add(
    HttpApiEndpoint.get('GetGrant', '/grants/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(GrantSchema)
      .addError(GrantNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.del('RevokeGrant', '/grants/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addError(GrantNotFoundSchema, { status: 404 })
  )
  .add(HttpApiEndpoint.get('ListClients', '/clients').addSuccess(ClientsSchema))
  .add(
    HttpApiEndpoint.patch('UpdateClient', '/clients/:clientId')
      .setPath(Schema.Struct({ clientId: Schema.String }))
      .setPayload(UpdateClientSchema)
      .addSuccess(Client.Schema)
      .addError(ClientNotFoundSchema, { status: 404 })
      .addError(EssentialClientSchema, { status: 409 })
  )
  .add(
    HttpApiEndpoint.post('CreateRevocation', '/revocations')
      .setPayload(RevocationSchema)
      .addError(RevocationRejectedSchema, { status: 400 })
  )
  .add(
    HttpApiEndpoint.get('ListBrowserSessions', '/browser-sessions').addSuccess(
      BrowserSessionsSchema
    )
  )
  .add(
    HttpApiEndpoint.del('RevokeBrowserSession', '/browser-sessions/:sid')
      .setPath(Schema.Struct({ sid: Schema.String }))
      .addError(BrowserSessionNotFoundSchema, { status: 404 })
  )
  // Every *operator* endpoint here is scope-gated on the server (a `Scoped<…>`
  // capability per operation), so the shared `403 InsufficientScope` is declared
  // once at the group level rather than per endpoint — the generated client then
  // decodes it (naming the missing scopes) instead of an opaque `ResponseError`.
  // `GetSession` is authN-only and simply never returns it.
  .addError(InsufficientScopeSchema, { status: 403 })
  .middleware(RequireAuthMiddleware)
  .prefix('/authorization')

export {
  httpApiGroup,
  BrowserSessionNotFoundSchema,
  BrowserSessionSchema,
  BrowserSessionsSchema,
  ClientNotFoundSchema,
  ClientsSchema,
  EssentialClientSchema,
  GrantSchema,
  GrantsSchema,
  GrantNotFoundSchema,
  RevocationRejectedSchema,
  RevocationSchema,
  SessionSchema,
  UpdateClientSchema,
}
