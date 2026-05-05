import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

const ApprovedAppSchema = Schema.Struct({
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

const ApprovedAppsSchema = Schema.Array(ApprovedAppSchema)

const ApprovedAppNotFoundSchema = Schema.Struct({
  error: Schema.Literal('ApprovedAppNotFound'),
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
  .add(HttpApiEndpoint.get('ListApprovedApps', '/approved_apps').addSuccess(ApprovedAppsSchema))
  .add(
    HttpApiEndpoint.get('GetApprovedApp', '/approved_apps/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(ApprovedAppSchema)
      .addError(ApprovedAppNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.del('RevokeApprovedApp', '/approved_apps/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addError(ApprovedAppNotFoundSchema, { status: 404 })
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
  .prefix('/auth')

export {
  httpApiGroup,
  ApprovedAppSchema,
  ApprovedAppsSchema,
  ApprovedAppNotFoundSchema,
  HttpRequestSchema,
  HttpRequestsSchema,
  HttpRequestNotFoundSchema,
  RequestDecisionSchema,
}
