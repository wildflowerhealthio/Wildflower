
import { pipe, Option, Schema as S } from 'effect';

/**
 * Origin: `internal.rs::OAuthError` (RFC 6749 §5.2). NOTE: the Rust struct types `error` as
 * `String`; the closed `OAuthErrorCode` set in `error_codes.rs` is NOT reflected in the type utoipa
 * sees, so the generated schema is `string` (not a literal union). See README 'precision
 * regression'.
 */
export const OAuthError = S.Struct({
  error: S.String,
  error_description: S.optional(S.String),
});
export type OAuthError = S.Schema.Type<typeof OAuthError>;
export const OAuthErrorEncoded = S.encodedSchema(OAuthError);
export type OAuthErrorEncoded = S.Schema.Encoded<typeof OAuthError>;
