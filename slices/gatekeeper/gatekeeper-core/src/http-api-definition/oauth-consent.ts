import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from '../http-api-implementation/require-auth.ts'

const OAuthConsentSchema = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  scopes: Schema.Array(Schema.String),
  redirectUri: Schema.String,
  preApprovedScopes: Schema.Array(Schema.String),
  patient: Schema.NullishOr(Schema.String),
})

const ApproveOAuthConsentBody = Schema.Struct({
  approvedScopes: Schema.Array(Schema.String),
  patient: Schema.NullishOr(Schema.String),
})

const OAuthConsentResultSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('approved') }),
  Schema.Struct({ status: Schema.Literal('denied') }),
  Schema.Struct({ status: Schema.Literal('error'), message: Schema.String })
)

const OAuthConsentNotFoundSchema = Schema.Struct({
  error: Schema.Literal('OAuthConsentNotFound'),
  id: Schema.String,
})

const httpApiGroup = HttpApiGroup.make('oauth-consent', { topLevel: false })
  .add(
    HttpApiEndpoint.get('GetOAuthConsent', '/oauth-consents/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(OAuthConsentSchema)
      .addError(OAuthConsentNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('ApproveOAuthConsent', '/oauth-consents/:id/approve')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(ApproveOAuthConsentBody)
      .addSuccess(OAuthConsentResultSchema)
      .addError(OAuthConsentNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('DenyOAuthConsent', '/oauth-consents/:id/deny')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(OAuthConsentResultSchema)
      .addError(OAuthConsentNotFoundSchema, { status: 404 })
  )
  .middleware(RequireAuthMiddleware)
  .prefix('/access')

export {
  httpApiGroup,
  OAuthConsentSchema,
  OAuthConsentResultSchema,
  OAuthConsentNotFoundSchema,
  ApproveOAuthConsentBody,
}
