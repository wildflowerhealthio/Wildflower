import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

const DeviceConsentSchema = Schema.Struct({
  userCode: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  // The human-chosen device name the requester supplied (RFC 8628 extension). Nullable:
  // absent on requests made before the field existed, or when the device didn't name itself.
  deviceName: Schema.NullishOr(Schema.String),
  requestedScopes: Schema.Array(Schema.String),
  // The client's full `allowed_scopes` — the *expansion envelope* the approver can grant up to
  // (device-auth consent is expandable, `granted ⊆ allowed`, not clamped to `requestedScopes`).
  allowedScopes: Schema.Array(Schema.String),
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
  // An optional adjusted device name the settings approver may set before approving; omitted
  // ⇒ the stored name is kept (server-side COALESCE).
  deviceName: Schema.optional(Schema.String),
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
