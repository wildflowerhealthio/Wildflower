import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

const AuthorizationStatusSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({ status: Schema.Literal('denied') }),
  Schema.Struct({ status: Schema.Literal('approved'), redirect: Schema.String }),
  Schema.Struct({ status: Schema.Literal('error'), message: Schema.String })
)

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  expires_in: Schema.Int,
  scope: Schema.String,
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

const AuthorizeUrlParamsSchema = Schema.Struct({
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
// `withEncoding({ kind: 'UrlParams' })` pipe means the body is parsed
// from `application/x-www-form-urlencoded`; both members of the union
// have a string-only encoded shape.
const AuthorizationCodePayload = Schema.Struct({
  grant_type: Schema.Literal('authorization_code'),
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.String),
  code: Schema.NonEmptyString,
  code_verifier: Schema.String.pipe(Schema.minLength(43), Schema.maxLength(128)),
  redirect_uri: Schema.NonEmptyString,
})

const DeviceCodePayload = Schema.Struct({
  grant_type: Schema.Literal('urn:ietf:params:oauth:grant-type:device_code'),
  client_id: Schema.NonEmptyString,
  client_secret: Schema.optional(Schema.String),
  device_code: Schema.NonEmptyString,
})

const TokenExchangePayloadSchema = Schema.Union(AuthorizationCodePayload, DeviceCodePayload).pipe(
  HttpApiSchema.withEncoding({
    kind: 'UrlParams',
    contentType: 'application/x-www-form-urlencoded',
  })
)

const DeviceAuthorizationPayloadSchema = Schema.Struct({
  client_id: Schema.NonEmptyString,
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
  DeviceAuthorizationPayloadSchema,
  DeviceAuthorizationResponseSchema,
  TokenResponseSchema,
  OAuthError400Schema,
  OAuthError401Schema,
  OAuthError500Schema,
  AuthorizationStatusNotFoundSchema,
}
