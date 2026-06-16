
import { pipe, Option, Schema as S } from 'effect';

/**
 * RFC 7517 public JWK. Opaque key material; gatekeeper serializes a fixed RSA/EC shape but the wire
 * contract is an open object.
 */
export const JsonWebKey = S.Record({ key: S.String, value: S.Unknown });
export type JsonWebKey = S.Schema.Type<typeof JsonWebKey>;
export const JsonWebKeyEncoded = S.encodedSchema(JsonWebKey);
export type JsonWebKeyEncoded = S.Schema.Encoded<typeof JsonWebKey>;
