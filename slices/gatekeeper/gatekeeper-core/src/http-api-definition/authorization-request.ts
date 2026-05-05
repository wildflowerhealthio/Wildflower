import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from '../http-api-implementation/require-auth.ts'

const OAuth2AuthorizationRequest = Schema.Struct({
  _tag: Schema.Literal('oauth2'),
  id: Schema.String,
  clientId: Schema.String,
  scopes: Schema.Array(Schema.String),
  redirectUri: Schema.String,
  preApprovedScopes: Schema.Array(Schema.String),
  patient: Schema.NullishOr(Schema.String),
})

const PinCookieAuthorizationRequest = Schema.Struct({
  _tag: Schema.Literal('pin_cookie'),
  id: Schema.String,
  returnTo: Schema.String,
  expiresAt: Schema.DateTimeUtc,
})

const AuthorizationRequestSchema = Schema.Union(
  OAuth2AuthorizationRequest,
  PinCookieAuthorizationRequest
)

const OAuth2ApprovePatch = Schema.Struct({
  _tag: Schema.Literal('oauth2'),
  status: Schema.Literal('approved'),
  approvedScopes: Schema.Array(Schema.String),
  patient: Schema.NullishOr(Schema.String),
})

const OAuth2DenyPatch = Schema.Struct({
  _tag: Schema.Literal('oauth2'),
  status: Schema.Literal('denied'),
})

const PinCookieApprovePatch = Schema.Struct({
  _tag: Schema.Literal('pin_cookie'),
  status: Schema.Literal('approved'),
  pin: Schema.String,
  duration: Schema.Literal('request', '1min', '15min'),
})

const PinCookieDenyPatch = Schema.Struct({
  _tag: Schema.Literal('pin_cookie'),
  status: Schema.Literal('denied'),
})

const AuthorizationRequestPatchSchema = Schema.Union(
  OAuth2ApprovePatch,
  OAuth2DenyPatch,
  PinCookieApprovePatch,
  PinCookieDenyPatch
)

const AuthorizationRequestResultSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('approved') }),
  Schema.Struct({ status: Schema.Literal('denied') }),
  Schema.Struct({ status: Schema.Literal('invalid_pin') }),
  Schema.Struct({ status: Schema.Literal('error'), message: Schema.String })
)

const AuthorizationRequestNotFoundSchema = Schema.Struct({
  error: Schema.Literal('AuthorizationRequestNotFound'),
  id: Schema.String,
})

const InvalidPatchTagSchema = Schema.Struct({
  error: Schema.Literal('InvalidPatchTag'),
  expected: Schema.String,
  received: Schema.String,
})

const httpApiGroup = HttpApiGroup.make('authorization-request', { topLevel: false })
  .add(
    HttpApiEndpoint.get('GetAuthorizationRequest', '/authorization_request/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(AuthorizationRequestSchema)
      .addError(AuthorizationRequestNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.patch('PatchAuthorizationRequest', '/authorization_request/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(AuthorizationRequestPatchSchema)
      .addSuccess(AuthorizationRequestResultSchema)
      .addError(AuthorizationRequestNotFoundSchema, { status: 404 })
      .addError(InvalidPatchTagSchema, { status: 400 })
  )
  .middleware(RequireAuthMiddleware)
  .prefix('/auth')

export {
  httpApiGroup,
  AuthorizationRequestSchema,
  AuthorizationRequestPatchSchema,
  AuthorizationRequestResultSchema,
  AuthorizationRequestNotFoundSchema,
  InvalidPatchTagSchema,
}
