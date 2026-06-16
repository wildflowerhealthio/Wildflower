
import { pipe, Option, Schema as S } from 'effect';

/**
 * Origin: `token_exchange.rs::TokenPayload::DeviceCode` (grant_type =
 * urn:ietf:params:oauth:grant-type:device_code), plus body credentials.
 */
export const DeviceCodeTokenRequest = S.Struct({
  grant_type: S.Literal('urn:ietf:params:oauth:grant-type:device_code'),
  client_id: pipe(S.String, S.minLength(1)),
  client_secret: S.optional(S.String),
  device_code: pipe(S.String, S.minLength(1)),
});
export type DeviceCodeTokenRequest = S.Schema.Type<typeof DeviceCodeTokenRequest>;
export const DeviceCodeTokenRequestEncoded = S.encodedSchema(DeviceCodeTokenRequest);
export type DeviceCodeTokenRequestEncoded = S.Schema.Encoded<typeof DeviceCodeTokenRequest>;
