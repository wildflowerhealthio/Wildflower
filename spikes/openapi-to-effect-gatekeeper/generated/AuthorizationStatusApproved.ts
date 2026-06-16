
import { pipe, Option, Schema as S } from 'effect';

export const AuthorizationStatusApproved = S.Struct({
  status: S.Literal('approved'),
  redirect: S.String,
});
export type AuthorizationStatusApproved = S.Schema.Type<typeof AuthorizationStatusApproved>;
export const AuthorizationStatusApprovedEncoded = S.encodedSchema(AuthorizationStatusApproved);
export type AuthorizationStatusApprovedEncoded = S.Schema.Encoded<
  typeof AuthorizationStatusApproved
>;
