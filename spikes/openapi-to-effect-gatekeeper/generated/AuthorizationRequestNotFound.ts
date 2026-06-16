
import { pipe, Option, Schema as S } from 'effect';

/** Origin: `HandlerError::not_found("AuthorizationRequestNotFound", "id", ...)`. */
export const AuthorizationRequestNotFound = S.Struct({
  error: S.Literal('AuthorizationRequestNotFound'),
  id: S.String,
});
export type AuthorizationRequestNotFound = S.Schema.Type<typeof AuthorizationRequestNotFound>;
export const AuthorizationRequestNotFoundEncoded = S.encodedSchema(AuthorizationRequestNotFound);
export type AuthorizationRequestNotFoundEncoded = S.Schema.Encoded<
  typeof AuthorizationRequestNotFound
>;
