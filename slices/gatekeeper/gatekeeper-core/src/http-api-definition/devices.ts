import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

const DeviceConsentSchema = Schema.Struct({
  userCode: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  requestedScopes: Schema.Array(Schema.String),
})

const DeviceConsentResultSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('approved') }),
  Schema.Struct({ status: Schema.Literal('denied') })
)

const DeviceConsentNotFoundSchema = Schema.Struct({
  error: Schema.Literal('DeviceConsentNotFound'),
  userCode: Schema.String,
})

const DeviceConsentBodySchema = Schema.Struct({
  approvedScopes: Schema.Array(Schema.String),
})

const httpApiGroup = HttpApiGroup.make('devices', { topLevel: false })
  .add(
    HttpApiEndpoint.get('GetDeviceConsent', '/devices/:userCode')
      .setPath(Schema.Struct({ userCode: Schema.String }))
      .addSuccess(DeviceConsentSchema)
      .addError(DeviceConsentNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('ApproveDeviceConsent', '/devices/:userCode/approve')
      .setPath(Schema.Struct({ userCode: Schema.String }))
      .setPayload(DeviceConsentBodySchema)
      .addSuccess(DeviceConsentResultSchema)
      .addError(DeviceConsentNotFoundSchema, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post('DenyDeviceConsent', '/devices/:userCode/deny')
      .setPath(Schema.Struct({ userCode: Schema.String }))
      .addSuccess(DeviceConsentResultSchema)
      .addError(DeviceConsentNotFoundSchema, { status: 404 })
  )
  .middleware(RequireAuthMiddleware)
  .prefix('/access')

export {
  httpApiGroup,
  DeviceConsentSchema,
  DeviceConsentResultSchema,
  DeviceConsentNotFoundSchema,
  DeviceConsentBodySchema,
}
