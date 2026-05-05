import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from '../http-api-implementation/require-auth.ts'

const PinVerificationSchema = Schema.Struct({
  id: Schema.String,
  returnTo: Schema.String,
  expiresAt: Schema.DateTimeUtc,
})

const VerifyPinBody = Schema.Struct({
  pin: Schema.String,
  duration: Schema.Literal('request', '1min', '15min'),
})

const PinVerificationResultSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('approved') }),
  Schema.Struct({ status: Schema.Literal('denied') }),
  Schema.Struct({ status: Schema.Literal('invalid_pin') }),
  Schema.Struct({ status: Schema.Literal('error'), message: Schema.String })
)

const PinVerificationNotFoundSchema = Schema.Struct({
  error: Schema.Literal('PinVerificationNotFound'),
  id: Schema.String,
})

const httpApiGroup = HttpApiGroup.make('pin-verification', { topLevel: false })
  .add(
    HttpApiEndpoint.get('GetPinVerification', '/pin-verifications/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(PinVerificationSchema)
      .addError(PinVerificationNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('VerifyPin', '/pin-verifications/:id/verify')
      .setPath(Schema.Struct({ id: Schema.String }))
      .setPayload(VerifyPinBody)
      .addSuccess(PinVerificationResultSchema)
      .addError(PinVerificationNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('DenyPinVerification', '/pin-verifications/:id/deny')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(PinVerificationResultSchema)
      .addError(PinVerificationNotFoundSchema, { status: 404 })
  )
  .middleware(RequireAuthMiddleware)
  .prefix('/access')

export {
  httpApiGroup,
  PinVerificationSchema,
  PinVerificationResultSchema,
  PinVerificationNotFoundSchema,
  VerifyPinBody,
}
