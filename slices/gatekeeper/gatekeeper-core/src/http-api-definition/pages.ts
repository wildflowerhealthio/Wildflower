import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

const HtmlSuccess = HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' })

/**
 * Page endpoints owned by `gatekeeper-core` as **definitions only**. Core
 * does NOT ship a handler layer for this group — consumer slices (e.g.
 * `gatekeeper-web`) `Layer.provide` an implementation through the
 * phantom-id bridge described in `docs/Effect/HttpApi Composition How-To.md`.
 *
 * All pages are public (no `RequireAuthMiddleware`). Auth is JS-driven via
 * Bearer tokens on the API calls each page makes against `/access/*`.
 *
 * See `Pages.md` for the page contract: each endpoint's path, params, and
 * the minimum HTML the consumer is expected to produce.
 */
const httpApiGroup = HttpApiGroup.make('gatekeeper-pages', { topLevel: false })
  .add(
    HttpApiEndpoint.get('OAuthPollingPage', '/oauth/authorize/:id/ui')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HtmlSuccess)
  )
  .add(
    HttpApiEndpoint.get('OAuthConsentPage', '/access/oauth-consents/:id/ui')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(HtmlSuccess)
  )
  .add(HttpApiEndpoint.get('DeviceEntryPage', '/access/devices').addSuccess(HtmlSuccess))
  .add(
    HttpApiEndpoint.get('DeviceConsentPage', '/access/devices/:userCode/ui')
      .setPath(Schema.Struct({ userCode: Schema.String }))
      .addSuccess(HtmlSuccess)
  )

export { httpApiGroup }
