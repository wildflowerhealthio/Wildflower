import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

/**
 * Trust-on-first-use standing for the requesting app, tagged on `status`. Lets an
 * unknown `client_id`, or a known client whose redirect/scopes fall outside its
 * allowlist, reach the Owner consent page instead of being rejected outright — the
 * Owner is warned and must acknowledge before approving.
 *
 * - `registered` — the app, redirect URI, and every requested scope all match its
 *   existing registration. No warning is due.
 * - `new` — no registration exists for this `client_id` at all; the app has never
 *   been seen before. Approving will register it with the granted scopes.
 * - `changed` — the app is registered, but this request's redirect URI is not on
 *   its allowlist (`redirectUriIsNew`) and/or it asks for scopes
 *   (`newScopes`, a subset of the consent's `scopes`, in request order) outside its
 *   previously allowed set.
 */
const OAuthConsentRegistrationSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('registered') }),
  Schema.Struct({ status: Schema.Literal('new') }),
  Schema.Struct({
    status: Schema.Literal('changed'),
    redirectUriIsNew: Schema.Boolean,
    newScopes: Schema.Array(Schema.String),
  })
)

const OAuthConsentSchema = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  /**
   * The client's registered display name — the consent UI's primary identity
   * for the app. The server falls back to the raw `clientId` when the client
   * registration lookup misses, so this is always present.
   */
  clientName: Schema.String,
  scopes: Schema.Array(Schema.String),
  redirectUri: Schema.String,
  preApprovedScopes: Schema.Array(Schema.String),
  patient: Schema.NullishOr(Schema.String),
  /**
   * The trust-on-first-use standing this request was resolved with — see
   * {@link OAuthConsentRegistrationSchema}. Drives the Owner-facing warning
   * callout and gates whether {@link ApproveOAuthConsentBody.acknowledgedRegistration}
   * is required.
   */
  registration: OAuthConsentRegistrationSchema,
})

const ApproveOAuthConsentBody = Schema.Struct({
  approvedScopes: Schema.Array(Schema.String),
  patient: Schema.NullishOr(Schema.String),
  /**
   * Whether the Owner ticked the "I recognise this app and this redirect
   * address" acknowledgment. Required (and enforced server-side) whenever the
   * consent's {@link OAuthConsentRegistrationSchema} status is `new` or
   * `changed`; ignored for `registered`. Send `false` when no acknowledgment
   * was shown (the `registered` case).
   */
  acknowledgedRegistration: Schema.Boolean,
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

/**
 * Returned when an approval of a `new` or `changed` {@link OAuthConsentRegistrationSchema}
 * arrives without `acknowledgedRegistration: true` — the Owner must tick the
 * "I recognise this app" checkbox before the server will register/re-register the
 * client. Modeled as a 409 (conflict with the pending registration state) rather
 * than a 422; the exact status is provisional pending the server implementation.
 */
const RegistrationNotAcknowledgedSchema = Schema.Struct({
  error: Schema.Literal('RegistrationNotAcknowledged'),
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
      .addError(RegistrationNotAcknowledgedSchema, { status: 409 })
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
  OAuthConsentRegistrationSchema,
  OAuthConsentResultSchema,
  OAuthConsentNotFoundSchema,
  RegistrationNotAcknowledgedSchema,
  ApproveOAuthConsentBody,
}
