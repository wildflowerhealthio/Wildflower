import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

const HtmlSuccess = HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' })

/**
 * Page endpoints owned by `gatekeeper-core` as **definitions only**. Core
 * does NOT ship a handler layer for this group — consumer slices (e.g.
 * `gatekeeper-web`) `Layer.provide` an implementation through the
 * phantom-id bridge described in `docs/Effect/HttpApi Composition How-To.md`.
 *
 * Operator-facing pages under `/access/...` carry `RequireAuthMiddleware`
 * so a downstream adapter can't ship them unauthenticated by accident.
 * The polling/PIN entry pages remain public because the OAuth client and
 * the user logging in have no session yet.
 *
 * See `Pages.md` for the page contract: each endpoint's path, params, and
 * the minimum HTML the consumer is expected to produce.
 */
const httpApiGroup = HttpApiGroup.make('gatekeeper-pages', { topLevel: false })
  .add(
    HttpApiEndpoint.get('OAuthPollingPage', '/oauth/authorize/:id/page')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HtmlSuccess)
  )
  .add(
    HttpApiEndpoint.get('OAuthConsentPage', '/access/oauth-consents/:id/ui')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HtmlSuccess)
      .middleware(RequireAuthMiddleware)
  )
  .add(
    HttpApiEndpoint.get('PinLoginPage', '/login/pin/:id/page')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HtmlSuccess)
  )
  .add(
    HttpApiEndpoint.get('PinVerificationPage', '/access/pin-verifications/:id/ui')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HtmlSuccess)
      .middleware(RequireAuthMiddleware)
  )

export { httpApiGroup }
