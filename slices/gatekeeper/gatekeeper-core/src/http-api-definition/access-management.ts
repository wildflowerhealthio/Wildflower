import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { InsufficientScopeSchema } from 'shared-structures-core/http-api-definition'
import { RequireAuthMiddleware } from './require-auth.ts'
/**
 * A `Grant` is a materialized consent decision — the Owner approved a client for
 * a scope set at a point in time — that survives across requests so the client
 * isn't re-approved on every call. It's **polymorphic** (a discriminated union on
 * `grantType`), mirroring the server's parent-`grants` + per-variant-child storage
 * 1:1 (see docs/Persistence/Polymorphic Rows Explanation.md):
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

/**
 * A registered OAuth `Client` as the Owner's "Trusted apps" list reads it — one
 * `clients` row, seeded by a migration or created when the Owner approved an
 * unknown app (trust on first use). `secret_hash` never leaves the server.
 *
 * - `disabledAt` is when the Owner disabled the client, and `null` while it's
 *   enabled. While it's set, `/oauth/authorize` and `/oauth/token` refuse the
 *   client.
 * - `firstParty` marks the Wildflower host client, which can't be disabled (it's
 *   how the Owner reaches this surface at all).
 */
const ClientSchema = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  kind: Schema.Literal('public', 'confidential'),
  redirectUris: Schema.Array(Schema.String),
  allowedScopes: Schema.Array(Schema.String),
  allowedGrantTypes: Schema.Array(Schema.String),
  registeredAt: Schema.DateTimeUtc,
  disabledAt: Schema.NullOr(Schema.DateTimeUtc),
  firstParty: Schema.Boolean,
})

const ClientsSchema = Schema.Array(ClientSchema)

/**
 * `UpdateClient`'s body — the one client field the Owner can edit.
 *
 * `disabledAt` is required, `null` included:
 * - any time disables the client now. The server stamps its own now whatever
 *   time is sent, so a disable can be neither scheduled nor backdated (the
 *   owner UI sends its current time).
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

/** `409` from `UpdateClient` when it would disable the first-party host. */
const FirstPartyClientLockedSchema = Schema.Struct({
  error: Schema.Literal('FirstPartyClientLocked'),
  clientId: Schema.String,
})

/**
 * `HttpRequest`: a record of an inbound FHIR request that the gatekeeper
 * has parked for the Owner to approve or deny. The wire shape mirrors
 * the server's `httpRequests` storage row 1:1.
 *
 * `respondedAt` and `statusCode` populate once the Owner approves /
 * denies and the upstream call completes.
 */
const HttpRequestSchema = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  url: Schema.String,
  origin: Schema.String,
  userAgent: Schema.String,
  requestedAt: Schema.DateTimeUtc,
  status: Schema.String,
  statusCode: Schema.NullOr(Schema.Int),
  respondedAt: Schema.NullOr(Schema.DateTimeUtc),
})

const HttpRequestsSchema = Schema.Array(HttpRequestSchema)

const HttpRequestNotFoundSchema = Schema.Struct({
  error: Schema.Literal('HttpRequestNotFound'),
  id: Schema.String,
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
 *   disabling the first-party host client is a `409`.
 * - `ListRequests` / `GetRequest`: inspect parked FHIR requests waiting
 *   on Owner decision.
 * - `ApproveRequest` / `DenyRequest`: Owner decision for a parked FHIR
 *   request — the server resumes the parked request once the status
 *   flips.
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
      .addSuccess(ClientSchema)
      .addError(ClientNotFoundSchema, { status: 404 })
      .addError(FirstPartyClientLockedSchema, { status: 409 })
  )
  .add(HttpApiEndpoint.get('ListRequests', '/requests').addSuccess(HttpRequestsSchema))
  .add(
    HttpApiEndpoint.get('GetRequest', '/requests/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HttpRequestSchema)
      .addError(HttpRequestNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('ApproveRequest', '/requests/:id/approve')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addError(HttpRequestNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('DenyRequest', '/requests/:id/deny')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addError(HttpRequestNotFoundSchema, { status: 404 })
  )
  // Every *operator* endpoint here is scope-gated on the server (a `Scoped<…>`
  // capability per operation), so the shared `403 InsufficientScope` is declared
  // once at the group level rather than per endpoint — the generated client then
  // decodes it (naming the missing scopes) instead of an opaque `ResponseError`.
  // `GetSession` is authN-only and simply never returns it.
  .addError(InsufficientScopeSchema, { status: 403 })
  .middleware(RequireAuthMiddleware)
  .prefix('/access')

export {
  httpApiGroup,
  ClientNotFoundSchema,
  ClientSchema,
  ClientsSchema,
  FirstPartyClientLockedSchema,
  GrantSchema,
  GrantsSchema,
  GrantNotFoundSchema,
  HttpRequestSchema,
  HttpRequestsSchema,
  HttpRequestNotFoundSchema,
  SessionSchema,
  UpdateClientSchema,
}
