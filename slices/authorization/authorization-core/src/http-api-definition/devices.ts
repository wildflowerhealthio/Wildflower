import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { InsufficientScopeSchema } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
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
  // The launch patient a one-patient grant is bound to — stored on the authorization
  // request and minted into the token's `patient` claim (mirrors the oauth-consents
  // approve body). Omitted for all-patients grants.
  patient: Schema.optional(Schema.String),
})

/**
 * The scopes a session needs to read and decide device requests here:
 * `GetDeviceConsent` is gated on `wildflower/AuthorizationRequest.r`,
 * `ApproveDeviceConsent` / `DenyDeviceConsent` on `.u`. The server's gates are
 * `authorization-server-rust`'s `consent_reader_scopes` and
 * `consent_decider_scopes`, which `devices.test.ts` reads this list from.
 */
const DEVICE_CONSENT_SCOPES = [
  'wildflower/AuthorizationRequest.r',
  'wildflower/AuthorizationRequest.u',
] as const

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
  // Every endpoint here is scope-gated (`wildflower/AuthorizationRequest.r` to
  // read, `.u` to decide), so the shared `403 InsufficientScope` is declared
  // once at the group level: the generated client decodes it, naming the
  // missing scopes.
  .addError(InsufficientScopeSchema, { status: 403 })
  .middleware(RequireAuthMiddleware)
  .prefix('/authorization')

export {
  httpApiGroup,
  DEVICE_CONSENT_SCOPES,
  DeviceConsentSchema,
  DeviceConsentResultSchema,
  DeviceConsentNotFoundSchema,
  DeviceConsentBodySchema,
}
