import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

const AuthorizationStatusSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({
    status: Schema.Literal('denied'),
    // `NullishOr(...).optionalWith` to mirror `TokenResponseSchema.refresh_token`
    // / `patient`: the server's `Option<String>` maps to `["string", "null"]` in
    // the spec, so tolerate an explicit `null` on the wire, not just omission.
    redirect: Schema.NullishOr(Schema.String).pipe(
      Schema.optionalWith({ default: () => undefined })
    ),
  }),
  Schema.Struct({ status: Schema.Literal('approved'), redirect: Schema.String }),
  Schema.Struct({ status: Schema.Literal('error'), message: Schema.String })
)

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Int,
  scope: Schema.String,
  refresh_token: Schema.NullishOr(Schema.String).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  patient: Schema.NullishOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
})

const DeviceAuthorizationResponseSchema = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Int,
  interval: Schema.Int,
})

/**
 * Query parameters accepted at `/oauth/authorize` per RFC 6749 §4.1.1 +
 * RFC 7636 (PKCE).
 *
 * @remarks
 * Stricter than the base spec: `state` is required (the spec merely
 * recommends it), and PKCE with S256 is mandatory — both matching the
 * OAuth 2.1 direction. `response_type` stays `NonEmptyString` rather than
 * `Literal('code')` so a wrong value reaches the handler and renders the
 * human-readable `unsupported_response_type` error page instead of a
 * generic schema-decode 400.
 */
const AuthorizeUrlParamsSchema = Schema.Struct({
  response_type: Schema.NonEmptyString,
  code_challenge_method: Schema.NonEmptyString,
  client_id: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  code_challenge: Schema.NonEmptyString,
  redirect_uri: Schema.NonEmptyString,
  state: Schema.String,
})

// Error response shapes per OAuth 2.0 §5.2 / RFC 8628 §3.5. One schema
// per HTTP status; the `error` literal field discriminates within a
// status. All carry an optional human-readable `error_description`.
const OAuthError400Schema = Schema.Struct({
  error: Schema.Literal(
    'invalid_request',
    'invalid_grant',
    'invalid_scope',
    'authorization_pending',
    'access_denied',
    'expired_token',
    'slow_down'
  ),
  error_description: Schema.optional(Schema.String),
})

const OAuthError401Schema = Schema.Struct({
  error: Schema.Literal('invalid_client'),
  error_description: Schema.optional(Schema.String),
})

const OAuthError500Schema = Schema.Struct({
  error: Schema.Literal('server_error'),
  error_description: Schema.optional(Schema.String),
})

const AuthorizationStatusNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AuthorizationRequestNotFound'),
  id: Schema.String,
})

// `/oauth/token` payload: discriminated union on `grant_type` between
// the authorization-code path and the RFC 8628 device-code path. The
// `withEncoding({ kind: 'UrlParams' })` pipe means the body is
// `application/x-www-form-urlencoded` (RFC 6749 §3.2); both members
// of the union have a string-only encoded shape.
//
// The encoding annotation MUST sit on each union member, not on the
// union wrapper: `HttpApiClient`'s encoder resolves payload encodings
// per member (a union may mix content types), so a wrapper-level
// annotation is honored by the server's decoder but silently ignored
// by the client — which then sends JSON that strict form-only servers
// (the Rust gatekeeper) reject as a malformed payload. Pinned by
// oauth.test.ts. The `withEncoding` calls are written out per member
// (not hoisted into a shared const) because the helper is generic per
// schema — a hoisted const pins its type parameters to `unknown`,
// which leaks into the whole API's requirements channel.
const AuthorizationCodePayload = Schema.Struct({
  grant_type: Schema.Literal('authorization_code'),
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.String),
  code: Schema.NonEmptyString,
  code_verifier: Schema.String.pipe(Schema.minLength(43), Schema.maxLength(128)),
  redirect_uri: Schema.NonEmptyString,
}).pipe(
  HttpApiSchema.withEncoding({
    kind: 'UrlParams',
    contentType: 'application/x-www-form-urlencoded',
  })
)

const DeviceCodePayload = Schema.Struct({
  grant_type: Schema.Literal('urn:ietf:params:oauth:grant-type:device_code'),
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.String),
  device_code: Schema.NonEmptyString,
}).pipe(
  HttpApiSchema.withEncoding({
    kind: 'UrlParams',
    contentType: 'application/x-www-form-urlencoded',
  })
)

// Refresh-token grant (RFC 6749 §6) — the gatekeeper's `/token` handler
// dispatches it (`token_exchange.rs::TokenPayload::RefreshToken`), so the
// client contract must be able to express it. Same per-member form encoding as
// the other grants.
const RefreshTokenPayload = Schema.Struct({
  grant_type: Schema.Literal('refresh_token'),
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.String),
  refresh_token: Schema.NonEmptyString,
}).pipe(
  HttpApiSchema.withEncoding({
    kind: 'UrlParams',
    contentType: 'application/x-www-form-urlencoded',
  })
)

const TokenExchangePayloadSchema = Schema.Union(
  AuthorizationCodePayload,
  DeviceCodePayload,
  RefreshTokenPayload
)

const DeviceAuthorizationPayloadSchema = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
}).pipe(
  HttpApiSchema.withEncoding({
    kind: 'UrlParams',
    contentType: 'application/x-www-form-urlencoded',
  })
)

const httpApiGroup = HttpApiGroup.make('oauth', { topLevel: false })
  .add(
    HttpApiEndpoint.get('Authorize', '/authorize')
      .setUrlParams(AuthorizeUrlParamsSchema)
      .addSuccess(HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' }))
  )
  .add(
    HttpApiEndpoint.get('AuthorizationStatus', '/authorize/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(AuthorizationStatusSchema)
      .addError(AuthorizationStatusNotFoundSchema, { status: 404 })
      .addError(OAuthError500Schema, { status: 500 })
  )
  .add(
    HttpApiEndpoint.post('TokenExchange', '/token')
      .setPayload(TokenExchangePayloadSchema)
      .addSuccess(TokenResponseSchema)
      .addError(OAuthError400Schema, { status: 400 })
      .addError(OAuthError401Schema, { status: 401 })
      .addError(OAuthError500Schema, { status: 500 })
  )
  .add(
    HttpApiEndpoint.post('DeviceAuthorization', '/device_authorization')
      .setPayload(DeviceAuthorizationPayloadSchema)
      .addSuccess(DeviceAuthorizationResponseSchema)
      .addError(OAuthError400Schema, { status: 400 })
      .addError(OAuthError401Schema, { status: 401 })
  )
  .prefix('/oauth')

export {
  httpApiGroup,
  AuthorizationCodePayload,
  AuthorizationStatusSchema,
  AuthorizeUrlParamsSchema,
  DeviceCodePayload,
  RefreshTokenPayload,
  DeviceAuthorizationPayloadSchema,
  DeviceAuthorizationResponseSchema,
  TokenResponseSchema,
  OAuthError400Schema,
  OAuthError401Schema,
  OAuthError500Schema,
  AuthorizationStatusNotFoundSchema,
}
