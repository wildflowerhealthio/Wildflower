import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import type { GrantRow, HttpRequestRow } from '../livestore/index.ts'
import { RequireAuthMiddleware } from './require-auth.ts'

/**
 * `Grant`: a record that the Owner approved a specific `(clientId,
 * redirectUri)` pair to receive tokens for a specific scope set, at a
 * specific point in time. A Grant is the materialized consent decision —
 * it survives across requests so the OAuth client doesn't have to be
 * re-approved on every authorize call.
 *
 * The wire shape mirrors the `grants` table row 1:1; the
 * `_grantWireMirrorsRow` thunk below is a compile-time guard — it never
 * runs, but if a column is added or renamed on the table, the assignment
 * stops type-checking here and forces the schema to track.
 *
 * `lastUsedAt` is null until the first time a token minted from this
 * Grant gets used.
 */
const GrantSchema = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  scopes: Schema.Array(Schema.String),
  redirectUri: Schema.String,
  grantedAt: Schema.DateTimeUtc,
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtc),
  patient: Schema.NullOr(Schema.String),
  // oxlint-disable-next-line typescript/no-explicit-any
}) satisfies Schema.Schema<GrantRow, any, never>

const GrantsSchema = Schema.Array(GrantSchema)

const GrantNotFoundSchema = Schema.Struct({
  error: Schema.Literal('GrantNotFound'),
  id: Schema.String,
})

/**
 * `HttpRequest`: a record of an inbound FHIR request that the gatekeeper
 * has parked for the Owner to approve or deny. Lives on the
 * `httpRequests` table; the wire shape mirrors the row 1:1 — the
 * `satisfies` clause below is the compile-time guard.
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
  // oxlint-disable-next-line typescript/no-explicit-any
}) satisfies Schema.Schema<HttpRequestRow, any, never>

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
 *   request — the upstream consumer (`internal/await-row.ts`) resumes
 *   once the status flips.
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
