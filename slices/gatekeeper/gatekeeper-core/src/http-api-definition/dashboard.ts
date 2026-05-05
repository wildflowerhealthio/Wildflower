import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from '../http-api-implementation/require-auth.ts'

const ClientSchema = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  type: Schema.String,
  scopes: Schema.Array(Schema.String),
  redirectUri: Schema.NullOr(Schema.String),
  approvedAt: Schema.DateTimeUtc,
  lastAccessedAt: Schema.NullOr(Schema.DateTimeUtc),
  label: Schema.String,
  patient: Schema.NullOr(Schema.String),
})

const ClientsSchema = Schema.Array(ClientSchema)

const ClientNotFoundSchema = Schema.Struct({
  error: Schema.Literal('ClientNotFound'),
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

const RequestDecisionSchema = Schema.Struct({
  status: Schema.Literal('approved', 'rejected'),
})

const httpApiGroup = HttpApiGroup.make('auth-dashboard', { topLevel: false })
  .add(HttpApiEndpoint.get('ListClients', '/clients').addSuccess(ClientsSchema))
  .add(
    HttpApiEndpoint.get('GetClient', '/clients/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(ClientSchema)
      .addError(ClientNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.del('RevokeClient', '/clients/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addError(ClientNotFoundSchema, { status: 404 })
  )
  .add(HttpApiEndpoint.get('ListRequests', '/requests').addSuccess(HttpRequestsSchema))
  .add(
    HttpApiEndpoint.get('GetRequest', '/requests/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HttpRequestSchema)
      .addError(HttpRequestNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.patch('DecideRequest', '/requests/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(RequestDecisionSchema)
      .addError(HttpRequestNotFoundSchema, { status: 404 })
  )
  .middleware(RequireAuthMiddleware)
  .prefix('/auth')

export {
  httpApiGroup,
  ClientSchema,
  ClientsSchema,
  ClientNotFoundSchema,
  HttpRequestSchema,
  HttpRequestsSchema,
  HttpRequestNotFoundSchema,
  RequestDecisionSchema,
}
