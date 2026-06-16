
import { pipe, Option, Schema as S } from 'effect';

/**
 * Origin: `internal.rs::TokenResponse` (RFC 6749 §5.1). `refresh_token` and `patient` use
 * `#[serde(skip_serializing_if = "Option::is_none")]`, so they are optional (omitted, not null).
 */
export const TokenResponse = S.Struct({
  access_token: S.String,
  token_type: S.String,
  expires_in: pipe(S.Number, S.int()),
  scope: S.String,
  refresh_token: S.optional(S.String),
  patient: S.optional(S.String),
});
export type TokenResponse = S.Schema.Type<typeof TokenResponse>;
export const TokenResponseEncoded = S.encodedSchema(TokenResponse);
export type TokenResponseEncoded = S.Schema.Encoded<typeof TokenResponse>;
