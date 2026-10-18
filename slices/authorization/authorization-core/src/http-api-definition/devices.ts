import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { InsufficientScopeSchema } from '@wildflowerhealthio/shared-structures-core/http-api-definition'
import { Schema } from 'effect'
import { RequireAuthMiddleware } from './require-auth.ts'

const DeviceConsentSchema = Schema.Struct({
  // What asks: a device, through the RFC 8628 device-code flow, or a browser that wants a
  // browser session (a browser pairing, started at `/oauth/pair`). A browser is always remote:
  // the Owner's own browser signs in on the server's device instead.
  kind: Schema.Literal('device', 'browser'),
  userCode: Schema.String,
  clientId: Schema.String,
  clientName: Schema.String,
  // The human-chosen device name the requester supplied (RFC 8628 extension), or a browser's
  // name. Nullable: absent when a device didn't name itself; a browser always has one.
  deviceName: Schema.NullishOr(Schema.String),
  requestedScopes: Schema.Array(Schema.String),
  // The *expansion envelope* the approver can grant up to (device-auth consent is expandable,
  // `granted ⊆ allowed`, not clamped to `requestedScopes`): a device client's full
  // `allowed_scopes`, or for a browser the Owner's scopes.
  allowedScopes: Schema.Array(Schema.String),
  // The approval scopes the reader's own token lacks to approve this request:
  // `wildflower/AuthorizationRequest.u` to decide it at all, and for a device
  // `wildflower/Grant.c`, for the standing grant approving it records (a
  // browser pairing records none). Empty when the reader may approve;
  // otherwise an approval answers `403 InsufficientScope` naming them, and
  // the device page sends the Owner to the device running the server.
  missingApprovalScopes: Schema.Array(Schema.String),
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
 * The scopes the device routes are gated on: `GetDeviceConsent` on
 * `wildflower/AuthorizationRequest.r`, `ApproveDeviceConsent` /
 * `DenyDeviceConsent` on `.u`. A session without them can't open a request
 * here at all. Approving one can take more, the request's approval scopes
 * (`wildflower/Grant.c` for a device), which the read reports in
 * {@link DeviceConsentSchema}'s `missingApprovalScopes`. The server's gates are
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
