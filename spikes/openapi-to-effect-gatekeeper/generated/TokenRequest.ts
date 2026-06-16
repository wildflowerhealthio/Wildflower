
import { pipe, Option, Schema as S } from 'effect';

import { AuthorizationCodeTokenRequest } from './AuthorizationCodeTokenRequest.ts';
import { DeviceCodeTokenRequest } from './DeviceCodeTokenRequest.ts';
import { RefreshTokenTokenRequest } from './RefreshTokenTokenRequest.ts';

/**
 * Origin: `token_exchange.rs::TokenPayload` — an internally-tagged enum on `grant_type` with THREE
 * variants. utoipa emits a discriminated `oneOf`.
 */
export const TokenRequest = S.Union(
  AuthorizationCodeTokenRequest,
  DeviceCodeTokenRequest,
  RefreshTokenTokenRequest,
);
export type TokenRequest = S.Schema.Type<typeof TokenRequest>;
export const TokenRequestEncoded = S.encodedSchema(TokenRequest);
export type TokenRequestEncoded = S.Schema.Encoded<typeof TokenRequest>;
