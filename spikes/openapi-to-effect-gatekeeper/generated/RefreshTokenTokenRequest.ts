
import { pipe, Option, Schema as S } from 'effect';

/**
 * Origin: `token_exchange.rs::TokenPayload::RefreshToken` (grant_type = refresh_token), plus body
 * credentials. NOTE: this whole grant is ABSENT from the current TS `TokenExchangePayloadSchema`
 * union. See README 'drift'.
 */
export const RefreshTokenTokenRequest = S.Struct({
  grant_type: S.Literal('refresh_token'),
  client_id: pipe(S.String, S.minLength(1)),
  client_secret: S.optional(S.String),
  refresh_token: pipe(S.String, S.minLength(1)),
});
export type RefreshTokenTokenRequest = S.Schema.Type<typeof RefreshTokenTokenRequest>;
export const RefreshTokenTokenRequestEncoded = S.encodedSchema(RefreshTokenTokenRequest);
export type RefreshTokenTokenRequestEncoded = S.Schema.Encoded<typeof RefreshTokenTokenRequest>;
