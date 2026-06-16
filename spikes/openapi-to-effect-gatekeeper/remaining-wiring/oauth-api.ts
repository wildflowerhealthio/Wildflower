/**
 * REMAINING HAND-WIRING — what `openapi-to-effect` does NOT generate.
 *
 * `openapi-to-effect` emits only the `Schema.*` value/struct/union shapes under
 * `../generated/`. Everything in THIS file is the layer that still has to be
 * written (or carried over) by hand to get from "generated schemas" to the
 * project's actual `HttpApiGroup` + derived `HttpApiClient`. It mirrors the
 * real definition at
 * `slices/gatekeeper/gatekeeper-core/src/http-api-definition/oauth.ts`.
 *
 * This file is illustrative: the `spikes/` tree lives outside the pnpm
 * workspace, so it is not type-checked or built by `vp`. It is written against
 * the same `@effect/platform` 0.96 API the repo uses, to show the boundary
 * precisely — not to be imported.
 *
 * What the generator gave us (imported below, verbatim from ../generated):
 *   - TokenResponse, OAuthError, AuthorizationRequestNotFound
 *   - DeviceAuthorizationResponse, Jwks
 *   - AuthorizationStatus (Union) + its 4 members
 *   - AuthorizationCodeTokenRequest / DeviceCodeTokenRequest /
 *     RefreshTokenTokenRequest (+ the TokenRequest union)
 *
 * What still has to be written by hand (everything below):
 *   1. Endpoints: HTTP method + path + operationId per route.
 *   2. Query/path params — openapi-to-effect only walks components/schemas, so
 *      `parameters` (the /authorize query, the /authorize/:id path param) are
 *      NOT generated. Hand-written here.
 *   3. The form-urlencoded encoding on each token-request member — the
 *      generated structs are plain (JSON) shapes; the UrlParams encoding that
 *      the Rust gatekeeper REQUIRES has to be re-applied per union member.
 *   4. Per-status error wiring (.addError(schema, { status })).
 *   5. The text/html success of /authorize.
 *   6. Group name, prefix, and assembly into the parent HttpApi.
 *   7. The client is then derived as today (HttpApiClient.make) — no change.
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

// --- Generated schemas (the part openapi-to-effect produced) -----------------
import { AuthorizationCodeTokenRequest } from '../generated/AuthorizationCodeTokenRequest.ts'
import { AuthorizationRequestNotFound } from '../generated/AuthorizationRequestNotFound.ts'
import { AuthorizationStatus } from '../generated/AuthorizationStatus.ts'
import { DeviceCodeTokenRequest } from '../generated/DeviceCodeTokenRequest.ts'
import { DeviceAuthorizationRequest } from '../generated/DeviceAuthorizationRequest.ts'
import { DeviceAuthorizationResponse } from '../generated/DeviceAuthorizationResponse.ts'
import { Jwks } from '../generated/Jwks.ts'
import { OAuthError } from '../generated/OAuthError.ts'
import { RefreshTokenTokenRequest } from '../generated/RefreshTokenTokenRequest.ts'
import { TokenResponse } from '../generated/TokenResponse.ts'

// --- (2) Query/path params — NOT generated, hand-written ----------------------
// openapi-to-effect skips `parameters`; only request/response bodies under
// components/schemas are emitted. So this whole schema is net-new manual work
// (here it is just copied from the existing oauth.ts).
const AuthorizeUrlParamsSchema = Schema.Struct({
  response_type: Schema.NonEmptyString,
  code_challenge_method: Schema.NonEmptyString,
  client_id: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  code_challenge: Schema.NonEmptyString,
  redirect_uri: Schema.NonEmptyString,
  state: Schema.String,
})

// --- (3) Form-urlencoded re-encoding — NOT generated --------------------------
// The Rust gatekeeper only accepts `application/x-www-form-urlencoded` at
// /token and /device_authorization (token_request.rs). The generated structs
// are plain JSON shapes, so the UrlParams encoding has to be re-applied — and,
// per the note in the real oauth.ts, it MUST sit on each union member, not on
// the union wrapper (the client's encoder resolves encodings per member). The
// `withEncoding(...)` calls are written out per member rather than hoisted into
// a shared const, because that helper is generic per schema: a hoisted const
// pins its type params to `unknown` and leaks into the whole API's requirements
// channel. So the generated `TokenRequest` union can't be reused as-is for the
// payload; we rebuild it from the generated members with the encoding attached.
const TokenExchangePayloadSchema = Schema.Union(
  AuthorizationCodeTokenRequest.pipe(
    HttpApiSchema.withEncoding({ kind: 'UrlParams', contentType: 'application/x-www-form-urlencoded' })
  ),
  DeviceCodeTokenRequest.pipe(
    HttpApiSchema.withEncoding({ kind: 'UrlParams', contentType: 'application/x-www-form-urlencoded' })
  ),
  // ← present here; ABSENT from today's hand-written TS union
  RefreshTokenTokenRequest.pipe(
    HttpApiSchema.withEncoding({ kind: 'UrlParams', contentType: 'application/x-www-form-urlencoded' })
  )
)

const DeviceAuthorizationPayloadSchema = DeviceAuthorizationRequest.pipe(
  HttpApiSchema.withEncoding({ kind: 'UrlParams', contentType: 'application/x-www-form-urlencoded' })
)

// --- (1,4,5,6) Endpoints, statuses, content types, group, prefix — NOT generated
const httpApiGroup = HttpApiGroup.make('oauth', { topLevel: false })
  .add(
    HttpApiEndpoint.get('Authorize', '/authorize')
      .setUrlParams(AuthorizeUrlParamsSchema)
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }))
  )
  .add(
    HttpApiEndpoint.get('AuthorizationStatus', '/authorize/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(AuthorizationStatus) // generated union, reused as-is
      .addError(AuthorizationRequestNotFound, { status: 404 }) // generated schema, manual status
      .addError(OAuthError, { status: 500 })
  )
  .add(
    HttpApiEndpoint.post('TokenExchange', '/token')
      .setPayload(TokenExchangePayloadSchema)
      .addSuccess(TokenResponse) // generated — now carries refresh_token
      .addError(OAuthError, { status: 400 })
      .addError(OAuthError, { status: 401 })
      .addError(OAuthError, { status: 500 })
  )
  .add(
    HttpApiEndpoint.post('DeviceAuthorization', '/device_authorization')
      .setPayload(DeviceAuthorizationPayloadSchema)
      .addSuccess(DeviceAuthorizationResponse)
      .addError(OAuthError, { status: 400 })
      .addError(OAuthError, { status: 401 })
  )
  .prefix('/oauth')

// Jwks lives in its own group in the real code; shown here for completeness.
const jwksApiGroup = HttpApiGroup.make('oauth-discovery', { topLevel: false })
  .add(HttpApiEndpoint.get('JwksJson', '/jwks.json').addSuccess(Jwks))
  .prefix('/.well-known')

export { httpApiGroup, jwksApiGroup }
