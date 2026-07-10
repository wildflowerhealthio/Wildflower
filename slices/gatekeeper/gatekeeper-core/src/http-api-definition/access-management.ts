import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
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
 * Owner-only operator surface. Every endpoint here carries
 * `RequireAuthMiddleware` so the slice's `-core` layer cannot ship them
 * unauthenticated by accident.
 *
 * Endpoint roles:
 * - `ListGrants` / `GetGrant` / `RevokeGrant`: read or revoke previously
 *   recorded consent decisions. Revoking a Grant means the next
 *   `/oauth/authorize` for that `(clientId, redirectUri)` will hit the
 *   consent UI again instead of auto-approving.
 * - `ListRequests` / `GetRequest`: inspect parked FHIR requests waiting
 *   on Owner decision.
 * - `ApproveRequest` / `DenyRequest`: Owner decision for a parked FHIR
 *   request — the server resumes the parked request once the status
 *   flips.
 */
const httpApiGroup = HttpApiGroup.make('access-management', { topLevel: false })
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
  .middleware(RequireAuthMiddleware)
  .prefix('/access')

export {
  httpApiGroup,
  GrantSchema,
  GrantsSchema,
  GrantNotFoundSchema,
  HttpRequestSchema,
  HttpRequestsSchema,
  HttpRequestNotFoundSchema,
}
