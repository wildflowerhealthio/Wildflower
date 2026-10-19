# Tokens

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs}}

The Owner can revoke an issued token directly, behind `POST /authorization/revocations`: one token by its `jti`, or every token of a subject at once. It takes `wildflower/Token.d`. `Token` is broader than a refresh token: a denylisted `jti` or a bumped subject epoch is checked when an access token is verified, and the epoch also when a refresh token is redeemed (see [`bumping_the_client_s_epoch_stops_refresh`](<../../Integration Tests/Token Revocation Explanation.md#bumping_the_client_s_epoch_stops_refresh>)).

The capability touches no store, only the [revocation port](<../../Assembly/Ports and Adapters Explanation.md>), so it isn't generic over the store.

## `token_revoker_scopes`

The gate: `wildflower/Token.d`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs token_revoker_scopes}}

## `TokenRevoker`

Revoke issued tokens. It holds the revocation port.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker}}

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker::new}}

The route takes exactly one of the two modes per request, and refuses a body naming neither, both, or a `jti` without its `expiresAt`, with a `400`. It also refuses an `expiresAt` already past: that token is expired anyway.

## `revoke_jti`

**Denylist one token until its own expiry.** The caller passes the token's expiry, so the denylist row can be swept once the token would have expired anyway. The denylist row is tagged with the reason `admin`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker::revoke_jti}}

No unit test of its own. Exercised end to end by [`revocations_endpoint_revokes_by_jti`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_revokes_by_jti>) and [`revocations_endpoint_rejects_invalid_bodies`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_rejects_invalid_bodies>).

## `revoke_subject`

**Revoke every token a subject holds**, by bumping the subject's revocation epoch to now. A token's subject is its app's `client_id`, so this signs an app out everywhere.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/access/tokens.rs TokenRevoker::revoke_subject}}

No unit test of its own. Exercised end to end by [`revocations_endpoint_bulk_revokes_by_subject`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_bulk_revokes_by_subject>), [`revoking_the_host_app_s_subject_revokes_its_tokens`](<../../Integration Tests/Revocation Explanation.md#revoking_the_host_app_s_subject_revokes_its_tokens>), [`revocations_endpoint_requires_owner_auth`](<../../Integration Tests/Revocation Explanation.md#revocations_endpoint_requires_owner_auth>) and [`access_revocations_requires_token_delete_scope`](<../../Integration Tests/Scope Gating Explanation.md#access_revocations_requires_token_delete_scope>).
