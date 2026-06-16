
import { pipe, Option, Schema as S } from 'effect';

import { AuthorizationStatusPending } from './AuthorizationStatusPending.ts';
import { AuthorizationStatusDenied } from './AuthorizationStatusDenied.ts';
import { AuthorizationStatusApproved } from './AuthorizationStatusApproved.ts';
import { AuthorizationStatusError } from './AuthorizationStatusError.ts';

/**
 * Origin: `authorization_status.rs::AuthorizationStatus` — an internally-tagged enum (`#[serde(tag
 * = "status", rename_all = "lowercase")]`). utoipa emits this as a discriminated `oneOf`.
 */
export const AuthorizationStatus = S.Union(
  AuthorizationStatusPending,
  AuthorizationStatusDenied,
  AuthorizationStatusApproved,
  AuthorizationStatusError,
);
export type AuthorizationStatus = S.Schema.Type<typeof AuthorizationStatus>;
export const AuthorizationStatusEncoded = S.encodedSchema(AuthorizationStatus);
export type AuthorizationStatusEncoded = S.Schema.Encoded<typeof AuthorizationStatus>;
