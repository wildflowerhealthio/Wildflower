
import { pipe, Option, Schema as S } from 'effect';

/** Origin: `device_authorization.rs::DeviceAuthorizationResponse` (RFC 8628 §3.2). */
export const DeviceAuthorizationResponse = S.Struct({
  device_code: S.String,
  user_code: S.String,
  verification_uri: S.String,
  verification_uri_complete: S.String,
  expires_in: pipe(S.Number, S.int()),
  interval: pipe(S.Number, S.int()),
});
export type DeviceAuthorizationResponse = S.Schema.Type<typeof DeviceAuthorizationResponse>;
export const DeviceAuthorizationResponseEncoded = S.encodedSchema(DeviceAuthorizationResponse);
export type DeviceAuthorizationResponseEncoded = S.Schema.Encoded<
  typeof DeviceAuthorizationResponse
>;
