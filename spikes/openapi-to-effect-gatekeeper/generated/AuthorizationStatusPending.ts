
import { pipe, Option, Schema as S } from 'effect';

export const AuthorizationStatusPending = S.Struct({
  status: S.Literal('pending'),
});
export type AuthorizationStatusPending = S.Schema.Type<typeof AuthorizationStatusPending>;
export const AuthorizationStatusPendingEncoded = S.encodedSchema(AuthorizationStatusPending);
export type AuthorizationStatusPendingEncoded = S.Schema.Encoded<typeof AuthorizationStatusPending>;
