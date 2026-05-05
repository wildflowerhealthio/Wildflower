import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

const GrantSchema = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  scopes: Schema.Array(Schema.String),
  redirectUri: Schema.String,
  grantedAt: Schema.DateTimeUtc,
  lastUsedAt: Schema.NullOr(Schema.DateTimeUtc),
  patient: Schema.NullOr(Schema.String),
})

const GrantsSchema = Schema.Array(GrantSchema)

const GrantNotFoundSchema = Schema.Struct({
  error: Schema.Literal('GrantNotFound'),
  id: Schema.String,
})

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

const httpApiGroup = HttpApiGroup.make('gatekeeper-access', { topLevel: false })
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
