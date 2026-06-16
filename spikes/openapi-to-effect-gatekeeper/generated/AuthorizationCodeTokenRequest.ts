
import { pipe, Option, Schema as S } from 'effect';

/**
 * Origin: `token_exchange.rs::TokenPayload::AuthorizationCode` (grant_type = authorization_code),
 * plus the body `client_id`/`client_secret` that `resolve_client_credentials` reads from the same
 * form (the typed enum ignores them). `code_verifier` is RFC 7636 §4.1: 43-128 chars.
 */
export const AuthorizationCodeTokenRequest = S.Struct({
  grant_type: S.Literal('authorization_code'),
  client_id: pipe(S.String, S.minLength(1)),
  client_secret: S.optional(S.String),
  code: pipe(S.String, S.minLength(1)),
  code_verifier: pipe(S.String, S.minLength(43), S.maxLength(128)),
  redirect_uri: pipe(S.String, S.minLength(1)),
});
export type AuthorizationCodeTokenRequest = S.Schema.Type<typeof AuthorizationCodeTokenRequest>;
export const AuthorizationCodeTokenRequestEncoded = S.encodedSchema(AuthorizationCodeTokenRequest);
export type AuthorizationCodeTokenRequestEncoded = S.Schema.Encoded<
  typeof AuthorizationCodeTokenRequest
>;
