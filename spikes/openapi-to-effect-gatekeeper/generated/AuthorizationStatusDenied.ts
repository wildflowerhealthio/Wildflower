
import { pipe, Option, Schema as S } from 'effect';

/**
 * `redirect` is `#[serde(skip_serializing_if = "Option::is_none")]` — present only for code-flow
 * denials.
 */
export const AuthorizationStatusDenied = S.Struct({
  status: S.Literal('denied'),
  redirect: S.optional(S.String),
});
export type AuthorizationStatusDenied = S.Schema.Type<typeof AuthorizationStatusDenied>;
export const AuthorizationStatusDeniedEncoded = S.encodedSchema(AuthorizationStatusDenied);
export type AuthorizationStatusDeniedEncoded = S.Schema.Encoded<typeof AuthorizationStatusDenied>;
