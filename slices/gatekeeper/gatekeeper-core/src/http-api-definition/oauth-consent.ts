import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

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

/**
 * The outcome of an OAuth consent decision. The `approved` arm carries an
 * optional `redirect`: an authorization-code-flow approval returns the client
 * callback URL the caller should navigate to (mirrors `scopes-rust`'s
 * `redirect: Option<String>`, serde tag `status`, skipped when absent);
 * device-flow and other approvals omit it.
 */
const OAuthConsentResultSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('approved'), redirect: Schema.optional(Schema.String) }),
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
