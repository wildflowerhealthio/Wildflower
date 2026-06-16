
import { pipe, Option, Schema as S } from 'effect';

import { JsonWebKey } from './JsonWebKey.ts';

/** Origin: `jwks.rs::Jwks`. */
export const Jwks = S.Struct({
  keys: S.Array(JsonWebKey),
});
export type Jwks = S.Schema.Type<typeof Jwks>;
export const JwksEncoded = S.encodedSchema(Jwks);
export type JwksEncoded = S.Schema.Encoded<typeof Jwks>;
