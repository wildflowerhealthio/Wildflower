import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

const AuthorizationStatusSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({ status: Schema.Literal('declined') }),
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

const AuthorizeUrlParamsSchema = Schema.Struct({
  code_challenge_method: Schema.NonEmptyString,
  client_id: Schema.NonEmptyString,
  scope: Schema.NonEmptyString,
  code_challenge: Schema.NonEmptyString,
  redirect_uri: Schema.NonEmptyString,
  state: Schema.String,
  // Public OAuth client-facing literal. Internally translated to
  // `'out-of-band-polling'` at the boundary.
  display: Schema.optional(Schema.Literal('polling')),
})

const FormUrlEncodedHeadersSchema = Schema.Struct({
  'content-type': Schema.String.pipe(
    Schema.startsWith('application/x-www-form-urlencoded', {
      message: () => 'Content-Type must be application/x-www-form-urlencoded',
    })
  ),
})

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
  )
  .add(
    HttpApiEndpoint.post('TokenExchange', '/token')
      .setHeaders(FormUrlEncodedHeadersSchema)
      .addSuccess(TokenResponseSchema)
  )
  .prefix('/oauth')

export { httpApiGroup }
