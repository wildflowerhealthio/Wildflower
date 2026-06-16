
import { pipe, Option, Schema as S } from 'effect';

export const AuthorizationStatusError = S.Struct({
  status: S.Literal('error'),
  message: S.String,
});
export type AuthorizationStatusError = S.Schema.Type<typeof AuthorizationStatusError>;
export const AuthorizationStatusErrorEncoded = S.encodedSchema(AuthorizationStatusError);
export type AuthorizationStatusErrorEncoded = S.Schema.Encoded<typeof AuthorizationStatusError>;
