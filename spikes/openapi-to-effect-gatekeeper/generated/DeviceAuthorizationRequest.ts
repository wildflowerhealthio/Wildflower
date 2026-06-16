
import { pipe, Option, Schema as S } from 'effect';

/**
 * Origin: `device_authorization.rs::DeviceAuthorizationPayload` (typed body = `{ scope?: String }`)
 * plus the body `client_id`/`client_secret` that `resolve_client_credentials` reads from the same
 * form.
 */
export const DeviceAuthorizationRequest = S.Struct({
  client_id: pipe(S.String, S.minLength(1)),
  client_secret: S.optional(S.String),
  scope: S.optional(S.String),
});
export type DeviceAuthorizationRequest = S.Schema.Type<typeof DeviceAuthorizationRequest>;
export const DeviceAuthorizationRequestEncoded = S.encodedSchema(DeviceAuthorizationRequest);
export type DeviceAuthorizationRequestEncoded = S.Schema.Encoded<typeof DeviceAuthorizationRequest>;
