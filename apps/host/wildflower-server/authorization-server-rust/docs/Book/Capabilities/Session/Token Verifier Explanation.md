# Token Verifier

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs}}

The token verifier answers one question for every request that presents an [access token](<../../Domain/Access Token Explanation.md>): **is this a live token this server minted for itself?** It is the single place that question is answered, so a token is accepted or refused the same way wherever it is presented.

Its answer is the token's [`VerifiedClaims`](<../../Domain/Access Token Explanation.md#item-VerifiedClaims>), or an [`AccessTokenVerifyError`](<../../Domain/Access Token Explanation.md#item-AccessTokenVerifyError>) saying why not. **Revocation comes last**: a token is first proven genuine by [`verify_access_token`](<../../Domain/Access Token Explanation.md#item-verify_access_token>) against the stored keys, and only then asked whether it has since been withdrawn: by its [browser session](<../../Domain/Browser Session Explanation.md>), in the grant store, and by its `jti` or its subject's epoch, in the host's revocation store. A logout denylists a `jti`; an Owner's revoke or a grant's revoke moves a subject's epoch; signing a browser out revokes its session. **A browser session's own token, the one its cookie holds, lasts only as long as the session**: the host ends the Owner's same-device session by expiring it, before its token would expire, and the verifier refuses the token from then on. The tokens apps were issued under the session don't end with its expiry, only with its revocation.

The tests verify against a [fake store with one signing key, and a recording revocation check](<../Test Fixtures Explanation.md#token-verifier>).

## `domain::capabilities::session::token_verifier`

### `TokenVerifier`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::new}}

#### `verify`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify tests="tests::verifies_a_token_for_this_server_and_consults_revocation tests::rejects_a_token_for_another_server tests::rejects_a_path_under_the_origin_as_audience tests::revocation_is_the_last_gate_and_fails_closed tests::a_token_is_revoked_with_its_browser_session"}}

#### `verify_signed_and_session_live`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify_signed_and_session_live}}

### `ensure_own_session_live`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs ensure_own_session_live tests="tests::a_session_s_own_token_ends_with_the_session_s_expiry"}}
